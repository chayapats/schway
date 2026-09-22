import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectConfigPath, readConfigFile, userConfigPath } from "../config/config.ts";
import { version } from "../../package.json";

/** An enabled package with canonical, validated capabilities and a diagnostic source. */
export interface EnabledPackage {
  name: string;
  scope: "project" | "global";
  root: string;
  source: string;
  extensions: string[];
  skills: string[];
}

/** Resolve only explicitly enabled installed packages, validating every declaration without executing code. */
export async function discoverPackages(options: {
  workspaceRoot: string;
  home?: string;
  signal?: AbortSignal;
}): Promise<EnabledPackage[]> {
  const packages: EnabledPackage[] = [];
  const scopes = [
    ...(options.home ? [{ scope: "global" as const, root: join(options.home, ".schway"), config: userConfigPath(options.home) }] : []),
    { scope: "project" as const, root: options.workspaceRoot, config: projectConfigPath(options.workspaceRoot) },
  ];
  for (const { scope, root, config } of scopes) {
    options.signal?.throwIfAborted();
    const layer = await readConfigFile(config);
    if (layer && "error" in layer) throw new Error(layer.error);
    for (const name of layer?.packages ?? []) {
      options.signal?.throwIfAborted();
      const source = `${scope} package "${name}" (${config})`;
      let packageRoot: string;
      try {
        packageRoot = await realpath(join(root, "node_modules", name));
      } catch {
        throw new Error(`Missing ${source}. Install it with npm install --prefix ${JSON.stringify(root)} ${name}; Schway never installs packages automatically.`);
      }
      try {
        const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), { encoding: "utf8", signal: options.signal }));
        if (!isObject(manifest)) throw new Error("package.json must be an object");
        const schway = manifest.schway;
        if (!isObject(schway)) throw new Error("package.json requires a schway manifest object");
        if (Object.keys(schway).some(key => key !== "extensions" && key !== "skills")) {
          throw new Error("schway manifest accepts only extensions and skills arrays");
        }
        if (schway.extensions === undefined && schway.skills === undefined) throw new Error("schway must declare extensions or skills");
        const peer = isObject(manifest.peerDependencies) ? manifest.peerDependencies.schway : undefined;
        if (peer !== undefined && (typeof peer !== "string" || !peer.trim() || !Bun.semver.satisfies(version, peer))) {
          throw new Error(`Incompatible Schway peer ${JSON.stringify(peer)}; installed Schway is ${version}. Install a compatible package version.`);
        }
        if (isObject(manifest.dependencies) && manifest.dependencies.schway !== undefined) {
          throw new Error("Declare schway in peerDependencies instead of dependencies; packages must use the installed harness's public schway/extensions API.");
        }
        const extensions = await declaredPaths(packageRoot, schway.extensions, "extensions", options.signal);
        const skills = await declaredPaths(packageRoot, schway.skills, "skills", options.signal);
        packages.push({ name, scope, root: packageRoot, source, extensions, skills });
      } catch (error) {
        options.signal?.throwIfAborted();
        throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  options.signal?.throwIfAborted();
  return packages;
}

async function declaredPaths(root: string, value: unknown, kind: "extensions" | "skills", signal?: AbortSignal): Promise<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`schway.${kind} must be an array of nonempty package-relative paths`);
  }
  const paths: string[] = [];
  for (const entry of value as string[]) {
    signal?.throwIfAborted();
    const path = resolve(root, entry);
    if (isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || !inside(root, path)) {
      throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} escapes the package root; use a package-relative path`);
    }
    let canonical: string;
    try { canonical = await realpath(path); } catch {
      throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} is missing`);
    }
    if (!inside(root, canonical)) throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} escapes the canonical package root`);
    const info = await stat(canonical);
    if (kind === "extensions" ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} must be a ${kind === "extensions" ? "module file" : "skill directory"}`);
    }
    if (kind === "skills") {
      let file: string;
      try { file = await realpath(join(canonical, "SKILL.md")); } catch {
        throw new Error(`schway.skills entry ${JSON.stringify(entry)} is missing SKILL.md`);
      }
      if (!inside(root, file) || !(await stat(file)).isFile()) throw new Error(`schway.skills entry ${JSON.stringify(entry)} must contain SKILL.md inside the package root`);
    }
    paths.push(canonical);
  }
  return paths;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
