import type { ConfigDeprecation } from "../config/deprecations.ts";
import type { ConfigDiagnostic } from "../config/diagnostics.ts";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { satisfies, validRange } from "semver";
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

/** Safe identity and failure category for a configured package, separate from its runtime error text. */
export interface PackageIssue {
  scope: "project" | "global";
  name?: string;
  kind: "configuration" | "missing" | "entry" | "manifest" | "peer";
  /** Raw declared relative entry path; callers must redact and bound it before display. */
  entry?: string;
  /** Safe source reasons when package enablement could not be inspected. */
  configDiagnostics?: readonly ConfigDiagnostic[];
}

/** Resolve enabled packages, retaining the first error as the runtime loader always has. */
export async function discoverPackages(options: {
  /** Use the same supported legacy keys as the settings reader. */
  configDeprecations?: readonly ConfigDeprecation[];
  workspaceRoot: string;
  home?: string;
  signal?: AbortSignal;
}): Promise<EnabledPackage[]> {
  const inspected = await inspectPackages(options);
  if (inspected.diagnostics.length) throw new Error(inspected.diagnostics[0]);
  return inspected.packages;
}

/** Inspect each configured package independently without evaluating extension entrypoints. */
export async function inspectPackages(options: {
  /** Reuse a caller's exact config observations, including absent or invalid sources. */
  configFiles?: ReadonlyMap<string, Awaited<ReturnType<typeof readConfigFile>>>;
  /** Use the same supported legacy keys as the settings reader. */
  configDeprecations?: readonly ConfigDeprecation[];
  workspaceRoot: string;
  home?: string;
  signal?: AbortSignal;
}): Promise<{ packages: EnabledPackage[]; diagnostics: string[]; issues: PackageIssue[] }> {
  const packages: EnabledPackage[] = [];
  const diagnostics: string[] = [];
  const issues: PackageIssue[] = [];
  const scopes = [
    ...(options.home ? [{ scope: "global" as const, root: join(options.home, ".schway"), config: userConfigPath(options.home) }] : []),
    { scope: "project" as const, root: options.workspaceRoot, config: projectConfigPath(options.workspaceRoot) },
  ];
  for (const { scope, root, config } of scopes) {
    options.signal?.throwIfAborted();
    const layer = options.configFiles?.has(config) ? options.configFiles.get(config) : await readConfigFile(config, options.configDeprecations);
    if (layer && "error" in layer) {
      diagnostics.push(layer.error);
      issues.push({ scope, kind: "configuration", configDiagnostics: layer.diagnostics });
      continue;
    }
    for (const name of layer?.packages ?? []) {
      options.signal?.throwIfAborted();
      const source = `${scope} package "${name}" (${config})`;
      let kind: PackageIssue["kind"] = "manifest";
      let missingEntry: string | undefined;
      try {
        let packageRoot: string;
        try {
          packageRoot = await realpath(join(root, "node_modules", name));
        } catch {
          kind = "missing";
          throw new Error(`Missing ${source}. Install it with npm install --prefix ${JSON.stringify(root)} ${name}; Schway never installs packages automatically.`);
        }
        const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), { encoding: "utf8", signal: options.signal }));
        if (!isObject(manifest)) throw new Error("package.json must be an object");
        const schway = manifest.schway;
        if (!isObject(schway)) throw new Error("package.json requires a schway manifest object");
        if (Object.keys(schway).some(key => key !== "extensions" && key !== "skills")) {
          throw new Error("schway manifest accepts only extensions and skills arrays");
        }
        if (schway.extensions === undefined && schway.skills === undefined) throw new Error("schway must declare extensions or skills");
        const peer = isObject(manifest.peerDependencies) ? manifest.peerDependencies.schway : undefined;
        if (peer !== undefined) {
          if (typeof peer !== "string" || !peer.trim() || validRange(peer) === null) {
            kind = "peer";
            throw new Error(`Invalid Schway peer range ${JSON.stringify(peer)}; peerDependencies.schway must be a nonempty npm semver range.`);
          }
          if (!satisfies(version, peer)) {
            kind = "peer";
            throw new Error(`Incompatible Schway peer ${JSON.stringify(peer)}; installed Schway is ${version}. Install a compatible package version.`);
          }
        }
        const dependencyField = ["dependencies", "optionalDependencies"].find(field => {
          const dependencies = manifest[field];
          return isObject(dependencies) && dependencies.schway !== undefined;
        }) ?? ["bundleDependencies", "bundledDependencies"].find(field => {
          const bundled = manifest[field];
          return Array.isArray(bundled) && bundled.includes("schway");
        });
        // Boolean bundle-all declarations are covered by the direct dependency checks above.
        if (dependencyField) {
          throw new Error(`Declare schway in peerDependencies instead of ${dependencyField}; packages must use the installed harness's public schway/extensions API without bundling a second harness.`);
        }
        let extensions: string[];
        let skills: string[];
        try {
          extensions = await declaredPaths(packageRoot, schway.extensions, "extensions", options.signal);
          skills = await declaredPaths(packageRoot, schway.skills, "skills", options.signal);
        } catch (error) {
          if (error instanceof MissingPackageEntryError) {
            kind = "entry";
            missingEntry = error.entry;
          }
          throw error;
        }
        packages.push({ name, scope, root: packageRoot, source, extensions, skills });
      } catch (error) {
        options.signal?.throwIfAborted();
        // Native filesystem errors can include untrusted path or OS detail; keep diagnostics bounded.
        const message = error instanceof Error ? error.message : "Unable to inspect package";
        diagnostics.push(message.startsWith(`Missing ${source}.`) ? message : `${source}: ${message.slice(0, 500)}`);
        issues.push({ scope, name, kind, ...(missingEntry !== undefined ? { entry: missingEntry } : {}) });
      }
    }
  }
  options.signal?.throwIfAborted();
  return { packages, diagnostics, issues };
}

/** Carry a missing manifest entry without inferring its identity from an error string. */
class MissingPackageEntryError extends Error {
  constructor(readonly entry: string, message: string) { super(message); }
}

/** Resolve manifest entrypoints only when their canonical paths and required file types stay inside the package. */
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
      throw new MissingPackageEntryError(entry, `schway.${kind} entry ${JSON.stringify(entry)} is missing`);
    }
    if (!inside(root, canonical)) throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} escapes the canonical package root`);
    const info = await stat(canonical);
    if (kind === "extensions" ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`schway.${kind} entry ${JSON.stringify(entry)} must be a ${kind === "extensions" ? "module file" : "skill directory"}`);
    }
    if (kind === "skills") {
      let file: string;
      try { file = await realpath(join(canonical, "SKILL.md")); } catch {
        throw new MissingPackageEntryError(join(entry, "SKILL.md"), `schway.skills entry ${JSON.stringify(entry)} is missing SKILL.md`);
      }
      if (!inside(root, file) || !(await stat(file)).isFile()) throw new Error(`schway.skills entry ${JSON.stringify(entry)} must contain SKILL.md inside the package root`);
    }
    paths.push(canonical);
  }
  return paths;
}

/** Test whether a resolved path is the root itself or one of its descendants. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Narrow parsed manifest values to non-null objects while excluding arrays. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
