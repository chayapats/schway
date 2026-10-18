import type { ConfigDeprecation } from "../config/deprecations.ts";
import type { ConfigDiagnosticContext } from "../config/diagnostics.ts";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { discoverPackages, type EnabledPackage } from "../packages/packages.ts";

/** Maximum SKILL.md body characters injected as dynamic context; oversize invocations fail instead of truncating. */
export const SKILL_BODY_LIMIT_CHARS = 32_000;

/** Dynamic context section naming model-eligible skills without embedding bodies. */
export const AVAILABLE_SKILLS_SECTION_NAME = "available-skills";

/** Dynamic context section carrying the user- or model-activated skill body for one turn. */
export const ACTIVE_SKILL_SECTION_NAME = "active-skill";

/** Built-in slash names a skill must not shadow; the TUI dispatcher owns behavior, this list owns collision detection. */
export const RESERVED_SKILL_NAMES: readonly string[] = [
  "new",
  "clear",
  "sessions",
  "delete-session",
  "resume",
  "model",
  "thinking",
  "theme",
  "session",
  "changes",
  "undo",
  "history",
  "compact",
  "context",
  "branch",
  "skills",
  "add-dir",
  "config",
  "login",
  "logout",
  "help",
  "quit",
];

/** Where a skill definition was discovered; project definitions override global ones. */
export type SkillScope = "project" | "global";

/** Validated skill identity and invocation metadata; the body stays on disk until activation. */
export interface SkillMetadata {
  name: string;
  description: string;
  /** True when frontmatter disables model invocation; the skill stays user-invokable. */
  userOnly: boolean;
  scope: SkillScope;
  /** Canonical skill directory; referenced resources resolve relative to it. */
  dir: string;
  /** Canonical SKILL.md path the metadata was parsed from. */
  skillFile: string;
  /** Human-readable source used in diagnostics and listings. */
  displayPath: string;
  /** Enabled npm package name, when this definition came from a manifest. */
  package?: string;
}

/** One unusable skill file with its source and actionable reason. */
export interface SkillDiagnostic {
  source: string;
  reason: string;
}

/** One skill name found twice at the same precedence level; never auto-resolved. */
export interface AmbiguousSkill {
  name: string;
  sources: string[];
}

/** One skill name colliding with a built-in slash command; explicit invocation is refused. */
export interface SkillCollision {
  name: string;
  command: string;
  source: string;
}

/** Discovery result: invokable skills plus explicit reports for everything unusable. */
export interface SkillDiscovery {
  skills: SkillMetadata[];
  ambiguous: AmbiguousSkill[];
  collisions: SkillCollision[];
  diagnostics: SkillDiagnostic[];
}

/** Loaded skill body and source attached as volatile context until the caller clears the activation. */
export interface ActiveSkill {
  name: string;
  body: string;
  source: string;
  scope: SkillScope;
  dir: string;
}

/** Validated SKILL.md frontmatter plus the raw body, which callers bound separately. */
export interface ParsedSkillFile {
  name: string;
  description: string;
  userOnly: boolean;
  body: string;
}

/** Split "/name args" into a lowercase name plus trailing args; null for ordinary prompts. */
export function splitSlashCommand(text: string): {
  name: string;
  args: string;
  raw: string;
} | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const space = trimmed.indexOf(" ");
  const name =
    (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  if (name.length === 0) {
    return null;
  }
  return {
    name,
    args: space === -1 ? "" : trimmed.slice(space + 1).trim(),
    raw: trimmed,
  };
}

/** Longest accepted skill name, matching the directory-name rule in the Agent Skills convention. */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Valid skill invocation tokens: lowercase letters, digits, and interior hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** True when the token can name a skill; anything else stays an ordinary prompt. */
export function isSkillNameToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= SKILL_NAME_MAX_LENGTH &&
    SKILL_NAME_PATTERN.test(value)
  );
}

/** Parse and validate required skill metadata and invocation flags, returning an error or an unbounded raw body. */
export function parseSkillFile(content: string): { ok: true; value: ParsedSkillFile } | { ok: false; error: string } {
  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") {
    start++;
  }
  if (start >= lines.length || lines[start]!.trim() !== "---") {
    return { ok: false, error: "missing frontmatter: SKILL.md must start with a '---' block" };
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, error: "malformed frontmatter: missing closing '---'" };
  }
  const fields = new Map<string, string>();
  const front = lines.slice(start + 1, end);
  for (let i = 0; i < front.length; i++) {
    const line = front[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return { ok: false, error: `malformed frontmatter line ${i + 1}: expected 'key: value'` };
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    let value = line.slice(separator + 1).trim();
    if (value === ">" || value === ">-" || value === ">+" || value === "|" || value === "|-" || value === "|+") {
      const folded = value.startsWith(">");
      const collected: string[] = [];
      while (i + 1 < front.length && /^[ \t]/.test(front[i + 1]!)) {
        i++;
        collected.push(front[i]!.replace(/^[ \t]+/, ""));
      }
      value = folded ? collected.join(" ") : collected.join("\n");
    }
    if (!fields.has(key)) {
      fields.set(key, unquote(value));
    }
  }
  const name = (fields.get("name") ?? "").trim();
  if (name.length === 0) {
    return { ok: false, error: "missing required frontmatter field 'name'" };
  }
  if (!isSkillNameToken(name)) {
    return {
      ok: false,
      error: `invalid skill name '${name}': use 1-64 lowercase letters, digits, or hyphens`,
    };
  }
  const description = (fields.get("description") ?? "").trim();
  if (description.length === 0) {
    return { ok: false, error: `skill '${name}' is missing required frontmatter field 'description'` };
  }
  let userOnly = false;
  for (const key of ["disable-model-invocation", "user-only"]) {
    const raw = fields.get(key);
    if (raw === undefined) {
      continue;
    }
    const parsed = parseFlag(key, raw);
    if ("error" in parsed) {
      return { ok: false, error: `skill '${name}': ${parsed.error}` };
    }
    userOnly = userOnly || parsed.value;
  }
  return {
    ok: true,
    value: { name, description, userOnly, body: lines.slice(end + 1).join("\n") },
  };
}

/** Discover metadata in project directories, project packages, global directories, then global packages, excluding ambiguous names and command collisions. */
export async function discoverSkills(options: {
  configDeprecations?: readonly ConfigDeprecation[];
  diagnosticContext?: ConfigDiagnosticContext;
  workspaceRoot: string;
  extraRoots?: readonly string[];
  home?: string;
  reservedNames?: readonly string[];
  signal?: AbortSignal;
  packages?: readonly EnabledPackage[];
  /** Read bounded frontmatter only for interactive discovery; activation validates the body. */
  metadataOnly?: boolean;
}): Promise<SkillDiscovery> {
  options.signal?.throwIfAborted();
  const reserved = options.reservedNames ?? RESERVED_SKILL_NAMES;
  const projectScopes = [];
  const roots = new Set(await Promise.all([options.workspaceRoot, ...(options.extraRoots ?? [])].map(canonicalDir)));
  for (const root of roots) {
    projectScopes.push(await readSkillScope(join(root, ".agents", "skills"), "project", options.workspaceRoot, options.signal, options.metadataOnly));
  }
  const project = {
    skills: projectScopes.flatMap(scope => scope.skills),
    diagnostics: projectScopes.flatMap(scope => scope.diagnostics),
  };
  const globalScope: { skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] } =
    options.home === undefined
      ? { skills: [], diagnostics: [] }
      : await readSkillScope(
          join(await canonicalDir(options.home), ".schway", "skills"),
          "global",
          undefined,
          options.signal, options.metadataOnly,
        );
  options.signal?.throwIfAborted();
  const packages = options.packages ?? await discoverPackages(options);
  const projectPackages = await readPackageSkills(packages.filter(pkg => pkg.scope === "project"), options.signal, options.metadataOnly);
  const globalPackages = await readPackageSkills(packages.filter(pkg => pkg.scope === "global"), options.signal, options.metadataOnly);
  const levels = [project, projectPackages, globalScope, globalPackages];
  const diagnostics = levels.flatMap(level => level.diagnostics);
  const ambiguous: AmbiguousSkill[] = [];
  const skills: SkillMetadata[] = [];
  const claimed = new Set<string>();
  for (const level of levels) {
    const candidates = level.skills.filter(skill => !claimed.has(skill.name));
    skills.push(...selectScopeSkills(candidates, diagnostics, ambiguous));
    // An ambiguous higher tier must never fall back to a lower-tier definition.
    for (const skill of level.skills) claimed.add(skill.name);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const collisions: SkillCollision[] = [];
  const available: SkillMetadata[] = [];
  for (const skill of skills) {
    if (reserved.includes(skill.name)) {
      collisions.push({ name: skill.name, command: `/${skill.name}`, source: skill.displayPath });
      continue;
    }
    available.push(skill);
  }
  return { skills: available, ambiguous, collisions, diagnostics };
}

/** Resolve an available skill by name, distinguishing unknown from ambiguous or colliding names. */
export function resolveSkillInvocation(
  discovery: SkillDiscovery,
  name: string,
): { ok: true; skill: SkillMetadata } | { ok: false; kind: "unknown" | "ambiguous" | "collision"; error: string } {
  const lowered = name.toLowerCase();
  const found = discovery.skills.find((skill) => skill.name === lowered);
  if (found) {
    return { ok: true, skill: found };
  }
  const clash = discovery.collisions.find((entry) => entry.name === lowered);
  if (clash) {
    return {
      ok: false,
      kind: "collision",
      error: `Skill '${lowered}' collides with built-in ${clash.command} (${clash.source}); rename the skill to invoke it explicitly.`,
    };
  }
  const dup = discovery.ambiguous.find((entry) => entry.name === lowered);
  if (dup) {
    return {
      ok: false,
      kind: "ambiguous",
      error: `Skill '${lowered}' is ambiguous; found in:\n${dup.sources.map((source) => `- ${source}`).join("\n")}\nRename or remove duplicates so one definition wins.`,
    };
  }
  const known =
    discovery.skills.length > 0
      ? ` Available: ${discovery.skills.map((skill) => skill.name).join(", ")}.`
      : " No skills are installed.";
  return { ok: false, kind: "unknown", error: `Unknown skill '${lowered}'.${known}` };
}

/** Discover and validate one named skill, enforcing model eligibility when requested and loading only its current body. */
export async function prepareSkillInvocation(options: {
  configDeprecations?: readonly ConfigDeprecation[];
  diagnosticContext?: ConfigDiagnosticContext;
  workspaceRoot: string;
  extraRoots?: readonly string[];
  home?: string;
  name: string;
  reservedNames?: readonly string[];
  modelInvocation?: boolean;
  signal?: AbortSignal;
  /** Explicit package set; an empty set prevents configuration/package discovery during activation. */
  packages?: readonly EnabledPackage[];
}): Promise<{ ok: true; skill: SkillMetadata; body: string } | { ok: false; error: string }> {
  options.signal?.throwIfAborted();
  if (options.modelInvocation && !isSkillNameToken(options.name)) {
    return { ok: false, error: "Skill activation requires a discovered skill name, not a path or alias." };
  }
  const discovery = await discoverSkills(options);
  options.signal?.throwIfAborted();
  const resolved = resolveSkillInvocation(discovery, options.name);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const loaded = await loadSkillBody(resolved.skill, options);
  options.signal?.throwIfAborted();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  return { ok: true, skill: resolved.skill, body: loaded.body };
}

/** Read a resolved skill's current body, revalidating its canonical source, metadata, model eligibility, and size. */
export async function loadSkillBody(
  skill: SkillMetadata,
  options: { modelInvocation?: boolean; signal?: AbortSignal } = {},
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  options.signal?.throwIfAborted();
  const suffix = options.modelInvocation ? "" : " The model turn was not started.";
  let content: string;
  try {
    if (await realpath(skill.skillFile) !== skill.skillFile || await realpath(skill.dir) !== skill.dir) {
      return { ok: false, error: `Skill '${skill.name}' changed source on disk; rediscover it and retry.${suffix}` };
    }
    if (!(await stat(skill.skillFile)).isFile()) {
      return { ok: false, error: `Skill '${skill.name}' is unavailable: SKILL.md is not a file.${suffix}` };
    }
    content = await readFile(skill.skillFile, { encoding: "utf8", signal: options.signal });
  } catch {
    options.signal?.throwIfAborted();
    return {
      ok: false,
      error: `Skill '${skill.name}' is unavailable: cannot read body at ${skill.displayPath}.${suffix}`,
    };
  }
  options.signal?.throwIfAborted();
  const parsed = parseSkillFile(content);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Skill '${skill.name}' is unavailable: ${parsed.error} (${skill.displayPath}).${suffix}`,
    };
  }
  if (parsed.value.name !== skill.name) {
    return {
      ok: false,
      error: `Skill '${skill.name}' changed on disk (now '${parsed.value.name}' at ${skill.displayPath}); re-run /skills and retry.${suffix}`,
    };
  }
  if (options.modelInvocation && (skill.userOnly || parsed.value.userOnly)) {
    return { ok: false, error: `Skill '${skill.name}' is user-only; only an explicit user invocation may activate it.` };
  }
  const body = parsed.value.body.trim();
  if (body.length === 0) {
    return {
      ok: false,
      error: `Skill '${skill.name}' has an empty body (${skill.displayPath}); add instructions before invoking.${suffix}`,
    };
  }
  if (body.length > SKILL_BODY_LIMIT_CHARS) {
    return {
      ok: false,
      error: `Skill '${skill.name}' exceeds the ${SKILL_BODY_LIMIT_CHARS} character body limit (${body.length} chars at ${skill.displayPath}); shorten SKILL.md before invoking.${suffix}`,
    };
  }
  return { ok: true, body };
}

/** Format model-eligible skills as the metadata-only available-skills context section. */
export function formatAvailableSkillsSection(skills: readonly SkillMetadata[]): string {
  const eligible = skills.filter((skill) => !skill.userOnly);
  const lines = ["Available skills (model: activate_skill with {\"name\": \"<skill-name>\"}; user: /<skill-name> [arguments]). One active skill lasts for this user turn; another activation replaces it:"];
  for (const skill of eligible) {
    lines.push(`- ${skill.name} - ${skill.description}`);
  }
  return lines.join("\n");
}

/** Format the user-facing /skills listing, including user-only marks and explicit diagnostics. */
export function formatSkillsListing(discovery: SkillDiscovery): string {
  const lines: string[] = [];
  if (discovery.skills.length === 0) {
    lines.push("No skills installed · /help browse commands");
  } else {
    lines.push("Choose a skill · /<skill-name> run:");
    for (const skill of discovery.skills) {
      const scope = skill.scope === "project" ? "project" : "global";
      const marker = skill.userOnly ? " (user-only)" : "";
      lines.push(`- ${skill.name}${marker} - ${skill.description} [${scope}${skill.package ? ` package ${skill.package}` : ""}]`);
    }
  }
  for (const dup of discovery.ambiguous) {
    lines.push(`Ambiguous skill '${dup.name}' is unavailable; found in:`);
    for (const source of dup.sources) {
      lines.push(`- ${source}`);
    }
  }
  for (const clash of discovery.collisions) {
    lines.push(
      `Skill '${clash.name}' collides with built-in ${clash.command} (${clash.source}) and cannot be invoked; rename the skill.`,
    );
  }
  for (const diagnostic of discovery.diagnostics) {
    lines.push(`Invalid skill at ${diagnostic.source}: ${diagnostic.reason}`);
  }
  lines.push("Run a skill · /<skill-name> [arguments]");
  return lines.join("\n");
}

/** Format one activated skill body as the active-skill dynamic context section. */
export function formatActiveSkillSection(skill: { name: string; source: string; body: string }): string {
  return `Skill: ${skill.name}\nSource: ${skill.source}\n${skill.body.replace(/\s+$/, "")}`;
}

/** Resolve a resource relative to the skill directory, rejecting empty, absolute, or lexical escape paths without resolving symlinks. */
export function resolveSkillResource(
  skill: { dir: string },
  target: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Skill resource path must not be empty." };
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { ok: false, error: `Skill resource '${target}' must be relative to its skill directory.` };
  }
  const resolved = resolve(skill.dir, trimmed);
  const rel = relative(skill.dir, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    return { ok: false, error: `Skill resource '${target}' escapes its skill directory.` };
  }
  return { ok: true, path: resolved };
}

/** Read a skill-relative file on demand, returning an error for invalid paths, unreadable files, or oversized content. */
export async function readSkillResource(
  skill: { dir: string; name?: string },
  target: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const resolved = resolveSkillResource(skill, target);
  if (!resolved.ok) {
    return resolved;
  }
  let content: string;
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) {
      return { ok: false, error: `Skill resource '${target}' is not a file.` };
    }
    content = await readFile(resolved.path, "utf8");
  } catch {
    return { ok: false, error: `Skill resource '${target}' cannot be read.` };
  }
  if (content.length > SKILL_BODY_LIMIT_CHARS) {
    return {
      ok: false,
      error: `Skill resource '${target}' exceeds the ${SKILL_BODY_LIMIT_CHARS} character limit; read a smaller range instead.`,
    };
  }
  return { ok: true, content };
}

/** Strip one layer of matching single or double quotes from a frontmatter value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Parse a frontmatter invocation flag, accepting only explicit true/false text. */
function parseFlag(key: string, raw: string): { value: boolean } | { error: string } {
  const lowered = raw.trim().toLowerCase();
  if (lowered === "true") {
    return { value: true };
  }
  if (lowered === "false") {
    return { value: false };
  }
  return { error: `frontmatter field '${key}' must be true or false, got '${raw}'` };
}

/** Extract a Node error code (such as ENOENT) when the failure carries one. */
function scopeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Normalize a scope-directory failure into a printable diagnostic reason. */
function scopeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one skill scope directory, returning parsed candidates plus malformed-file diagnostics. */
async function readSkillScope(
  scopeDir: string,
  scope: SkillScope,
  workspaceRoot?: string,
  signal?: AbortSignal,
  metadataOnly = false,
): Promise<{ skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] }> {
  signal?.throwIfAborted();
  const skills: SkillMetadata[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let entries: string[];
  try {
    entries = (await readdir(scopeDir)).sort();
  } catch (error) {
    if (scopeErrorCode(error) === "ENOENT") {
      return { skills, diagnostics };
    }
    diagnostics.push({
      source: scopeDir,
      reason: `cannot list ${scope} skills directory: ${scopeErrorMessage(error)}`,
    });
    return { skills, diagnostics };
  }
  const canonicalScope = await canonicalDir(scopeDir);
  for (const entry of entries) {
    signal?.throwIfAborted();
    const dir = join(scopeDir, entry);
    let entryStat;
    try {
      entryStat = await stat(dir);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) {
      continue;
    }
    const skillFile = join(dir, "SKILL.md");
    let fileStat;
    try {
      fileStat = await stat(skillFile);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) {
      continue;
    }
    const canonicalSkillFile = await canonicalDir(skillFile);
    const canonicalSkillDir = await canonicalDir(dir);
    const display =
      scope === "project" && workspaceRoot !== undefined
        ? displaySkillPath(canonicalSkillFile, await canonicalDir(workspaceRoot))
        : canonicalSkillFile;
    if (!isInside(canonicalScope, canonicalSkillFile)) {
      diagnostics.push({
        source: display,
        reason: `skill directory escapes ${scope} skills directory; refusing to load`,
      });
      continue;
    }
    let content: string;
    try {
      content = metadataOnly ? await readSkillFrontmatter(canonicalSkillFile, signal) : await readFile(canonicalSkillFile, { encoding: "utf8", signal });
    } catch {
      signal?.throwIfAborted();
      diagnostics.push({ source: display, reason: "SKILL.md cannot be read" });
      continue;
    }
    const parsed = parseSkillFile(content);
    if (!parsed.ok) {
      diagnostics.push({ source: display, reason: parsed.error });
      continue;
    }
    if (parsed.value.name !== entry) {
      diagnostics.push({
        source: display,
        reason: `skill name '${parsed.value.name}' does not match directory '${entry}'; invoking as '${parsed.value.name}'`,
      });
    }
    if (!metadataOnly && parsed.value.body.trim().length === 0) {
      diagnostics.push({ source: display, reason: `skill '${entry}' has an empty body` });
      continue;
    }
    skills.push({
      name: parsed.value.name,
      description: parsed.value.description,
      userOnly: parsed.value.userOnly,
      scope,
      dir: canonicalSkillDir,
      skillFile: canonicalSkillFile,
      displayPath: display,
    });
  }
  return { skills, diagnostics };
}

/** Parse only manifest-declared skill directories, keeping package identity in diagnostics. */
async function readPackageSkills(packages: readonly EnabledPackage[], signal?: AbortSignal, metadataOnly = false): Promise<{ skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] }> {
  const skills: SkillMetadata[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const pkg of packages) {
    for (const dir of pkg.skills) {
      signal?.throwIfAborted();
      const declaredFile = join(dir, "SKILL.md");
      let skillFile: string;
      let content: string;
      try {
        skillFile = await realpath(declaredFile);
        content = metadataOnly ? await readSkillFrontmatter(skillFile, signal) : await readFile(skillFile, { encoding: "utf8", signal });
        signal?.throwIfAborted();
      } catch {
        signal?.throwIfAborted();
        diagnostics.push({ source: `${pkg.source}: ${declaredFile}`, reason: "SKILL.md cannot be read" });
        continue;
      }
      const displayPath = `${pkg.source}: ${skillFile}`;
      const parsed = parseSkillFile(content);
      if (!parsed.ok || (!metadataOnly && !parsed.value.body.trim())) {
        diagnostics.push({ source: displayPath, reason: parsed.ok ? "skill has an empty body" : parsed.error });
        continue;
      }
      skills.push({ name: parsed.value.name, description: parsed.value.description, userOnly: parsed.value.userOnly,
        scope: pkg.scope, package: pkg.name, dir, skillFile, displayPath });
    }
  }
  return { skills, diagnostics };
}

/** Keep singly-defined names; report same-scope duplicates as ambiguous without picking a winner. */
function selectScopeSkills(
  candidates: SkillMetadata[],
  diagnostics: SkillDiagnostic[],
  ambiguous: AmbiguousSkill[],
): SkillMetadata[] {
  void diagnostics;
  const byName = new Map<string, SkillMetadata[]>();
  for (const skill of candidates) {
    const group = byName.get(skill.name) ?? [];
    group.push(skill);
    byName.set(skill.name, group);
  }
  const kept: SkillMetadata[] = [];
  for (const [name, group] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const distinct = [...new Map(group.map((skill) => [skill.dir, skill] as const)).values()];
    if (distinct.length > 1) {
      ambiguous.push({
        name,
        sources: distinct.map((skill) => skill.displayPath).sort(),
      });
      continue;
    }
    kept.push(distinct[0]!);
  }
  return kept;
}

/** Render a canonical project skill path relative to the workspace root when possible. */
function displaySkillPath(path: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    return path;
  }
  return rel.split(sep).join("/");
}

/** Canonicalize a path, falling back to the resolved absolute path when missing. */
async function canonicalDir(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** True when a canonical path stays inside a canonical root directory. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Read bounded metadata chunks and stop at the closing frontmatter, never loading the full body. */
async function readSkillFrontmatter(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("SKILL.md is not a file");
    const chunks: Buffer[] = [];
    for (let position = 0; position < 16_384; position += 512) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(512);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      chunks.push(chunk.subarray(0, bytesRead));
      const content = Buffer.concat(chunks).toString("utf8") + (position + bytesRead >= info.size ? "\n" : "");
      const match = /^\s*---[^\S\n]*\r?\n[\s\S]*?\n---[^\S\n]*\r?\n/.exec(content);
      if (match) return match[0];
      if (bytesRead < chunk.length) break;
    }
    throw new Error("missing closing frontmatter or metadata exceeds 16 KiB");
  } finally { await file.close(); }
}
