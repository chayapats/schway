import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, type Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Live roots from `makeTempRoot`, each mapped to the canonical temp directory it was created in. */
const ownedTempRoots = new Map<string, string>();

/** Record a fresh `mkdtemp` root after checking it sits directly in the canonical temp directory. */
function ownTempRoot(parent: string, dir: string): string {
  if (dirname(dir) !== parent) throw new Error(`Temporary root ${dir} is not directly inside ${parent}`);
  ownedTempRoots.set(dir, parent);
  return dir;
}

/** Create a canonical `mkdtemp` root directly under the OS temp directory; only the removal helpers here delete it. */
export async function makeTempRoot(prefix = "schway-"): Promise<string> {
  return ownTempRoot(await realpath(tmpdir()), await realpath(await mkdtemp(join(tmpdir(), prefix))));
}

/** Synchronous `makeTempRoot` for synchronous hooks and fixtures. */
export function makeTempRootSync(prefix = "schway-"): string {
  return ownTempRoot(realpathSync(tmpdir()), realpathSync(mkdtempSync(join(tmpdir(), prefix))));
}

/** True when `path` is `ancestor` or lies inside it. */
function within(ancestor: string, path: string): boolean {
  const rel = relative(ancestor, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Canonical form of an absolute path: its deepest existing ancestor resolved through symlinks, plus the missing rest. */
function canonical(path: string): string {
  const rest: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try { return join(realpathSync(current), ...rest); } catch { /* Try the parent. */ }
    if (dirname(current) === current) return path;
    rest.unshift(basename(current));
  }
}

function refusal(path: string, reason: string): Error {
  return new Error(`Refusing to remove ${JSON.stringify(path)}: ${reason}`);
}

/**
 * Throw when removing `path` would also remove the working directory, HOME, the checkout or the temp directory.
 * Paths are compared after realpath, which also settles case on case-insensitive volumes, and by device and
 * inode, which catches any other alias such as a bind mount.
 */
function assertKeepsProtectedPaths(path: string, tempParent: string): void {
  let info: Stats;
  try { info = lstatSync(path); } catch { return; }
  // Removing a missing path, a file or a final symlink can't remove a protected directory.
  if (!info.isDirectory()) return;
  const real = realpathSync(path), identity = statSync(real);
  let cwd: string | undefined;
  // A working directory that no longer exists can't be harmed, and process.cwd() may throw for it.
  try { cwd = process.cwd(); } catch { cwd = undefined; }
  const kept = [cwd !== undefined && existsSync(cwd) ? cwd : undefined, homedir(), resolve(import.meta.dir, ".."), tempParent];
  for (const protectedPath of kept) {
    if (protectedPath === undefined) continue;
    const resolved = canonical(protectedPath);
    if (within(real, resolved) || sharesIdentityWithAncestor(identity, resolved)) throw refusal(path, `it contains ${resolved}`);
  }
}

/** True when `path` or one of its existing ancestors is the directory `identity` describes. */
function sharesIdentityWithAncestor(identity: Stats, path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    try {
      const candidate = statSync(current);
      if (candidate.dev === identity.dev && candidate.ino === identity.ino) return true;
    } catch { /* Missing: check the parent. */ }
    if (dirname(current) === current) return false;
  }
}

/**
 * Throw unless `dir` is a live root from `makeTempRoot` that contains neither the checkout, the working
 * directory, HOME nor the temp directory itself. Recursive fixture cleanup goes through this check.
 */
export function assertRemovableTempRoot(dir: string): void {
  const parent = ownedTempRoots.get(dir);
  if (parent === undefined || dirname(dir) !== parent) throw refusal(dir, "not a temporary root this test process created");
  assertKeepsProtectedPaths(dir, parent);
}

/** Recursively remove a root that `makeTempRoot` created; refuses any other path (see `assertRemovableTempRoot`). */
export async function removeTempRoot(dir: string): Promise<void> {
  assertRemovableTempRoot(dir);
  ownedTempRoots.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Synchronous `removeTempRoot`. */
export function removeTempRootSync(dir: string): void {
  assertRemovableTempRoot(dir);
  ownedTempRoots.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Return the path that removing `path` would delete, after checking it lies strictly inside `root`, a live
 * root from `makeTempRoot`. Directories on the way are resolved through symlinks, so a link can't lead the
 * removal outside the root; a final symlink is removed itself, not its target.
 */
export function assertRemovableOwnedTree(root: string, path: string): string {
  const parent = ownedTempRoots.get(root);
  if (parent === undefined) throw refusal(path, `${JSON.stringify(root)} is not a temporary root this test process created`);
  if (!isAbsolute(path)) throw refusal(path, "not an absolute path");
  const lexical = resolve(path);
  const target = join(canonical(dirname(lexical)), basename(lexical));
  if (target === root || !within(root, target)) throw refusal(path, `not strictly inside ${root}`);
  assertKeepsProtectedPaths(target, parent);
  return target;
}

/** Recursively remove `path` strictly inside the owned temp root `root`; refuses anything else (see `assertRemovableOwnedTree`). */
export async function removeOwnedTree(root: string, path: string, options: { force?: boolean } = {}): Promise<void> {
  await rm(assertRemovableOwnedTree(root, path), { recursive: true, force: options.force ?? true });
}

/** Synchronous `removeOwnedTree`. */
export function removeOwnedTreeSync(root: string, path: string, options: { force?: boolean } = {}): void {
  rmSync(assertRemovableOwnedTree(root, path), { recursive: true, force: options.force ?? true });
}

/** Run `body`, then `cleanup`. A cleanup failure never hides the body's error: it becomes that error's cause. */
async function thenCleanUp(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let failure: { error: unknown } | undefined;
  try { await body(); } catch (error) { failure = { error }; }
  try { await cleanup(); } catch (cleanupError) {
    if (!failure) throw cleanupError;
    if (failure.error instanceof Error && failure.error.cause === undefined) {
      failure.error.cause = cleanupError;
      throw failure.error;
    }
    throw new AggregateError([failure.error, cleanupError], "The test failed, and so did removing its temporary root");
  }
  if (failure) throw failure.error;
}

/** Allocate and remove a canonical fixture root so runtime identity checks agree across OS temp aliases. */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempRoot();
  await thenCleanUp(() => fn(dir), () => removeTempRoot(dir));
}

export async function makeDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export async function makeSymlink(target: string, path: string): Promise<void> {
  await symlink(target, path);
}

/** Executable-lookup variables preserved for isolated CLI subprocesses. */
export const ISOLATED_CLI_KEEP_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "PATHEXT",
] as const;

/** Provider credentials never inherited by isolated CLI subprocesses. */
export const ISOLATED_CLI_STRIP_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

/** Isolated temp roots keeping user state separate from the workspace. */
export interface IsolatedCliDirs {
  root: string;
  home: string;
  work: string;
  sentinelPath: string;
  sentinelContent: string;
}

/** Run a callback with an empty isolated HOME, workspace, and sentinel; always removes the root. */
export async function withIsolatedCliDirs(
  fn: (dirs: IsolatedCliDirs) => Promise<void>,
): Promise<void> {
  const root = await makeTempRoot("schway-cli-");
  await thenCleanUp(async () => {
    const home = join(root, "home");
    const work = join(root, "work");
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    const sentinelContent = `sentinel-${crypto.randomUUID()}`;
    const sentinelPath = join(root, "sentinel.txt");
    await writeFile(sentinelPath, sentinelContent, "utf8");
    await fn({ root, home, work, sentinelPath, sentinelContent });
  }, () => removeTempRoot(root));
}

/** Build an explicit child env with isolated HOME, stripped credentials, and test overrides. */
export function buildIsolatedCliEnv(
  home: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ISOLATED_CLI_KEEP_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of ISOLATED_CLI_STRIP_ENV_KEYS) {
    delete env[key];
  }
  env.HOME = home;
  // Compare application state without Bun's OS-specific transpiler-cache writes in the fixture home.
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
  // Decorative TUI motion keeps renderer fixtures from ever reaching visual idle; animation has dedicated tests.
  env.SCHWAY_MOTION = "off";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  for (const key of ISOLATED_CLI_STRIP_ENV_KEYS) {
    if (!(key in overrides)) {
      delete env[key];
    }
  }
  return env;
}

/** Assert a CLI run left its sentinel intact and wrote no state outside HOME. */
export async function assertIsolatedCliClean(dirs: IsolatedCliDirs): Promise<void> {
  if (!dirs.home.startsWith(`${dirs.root}${sep}`)) {
    throw new Error(`Isolated HOME ${dirs.home} is not inside ${dirs.root}`);
  }
  if (dirs.home === process.env.HOME) {
    throw new Error("Isolated HOME must differ from the invoking user's HOME");
  }
  const sentinel = await readFile(dirs.sentinelPath, "utf8");
  if (sentinel !== dirs.sentinelContent) {
    throw new Error("Isolated CLI run modified its sentinel file");
  }
  for (const outside of [join(dirs.work, ".schway"), join(dirs.root, ".schway")]) {
    let exists = true;
    try {
      await stat(outside);
    } catch (error) {
      if (isNotFound(error)) {
        exists = false;
      } else {
        throw error;
      }
    }
    if (exists) {
      throw new Error(`Isolated CLI run wrote user state outside HOME: ${outside}`);
    }
  }
  let sessionsExist = true;
  try {
    await stat(join(dirs.home, ".schway", "sessions"));
  } catch (error) {
    if (isNotFound(error)) {
      sessionsExist = false;
    } else {
      throw error;
    }
  }
  if (sessionsExist) {
    throw new Error("Isolated CLI run created sessions on an early-failure path");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/** Expose v3 appended entries and selection settlements with their parents, retaining other durable records. */
export function decodeStoredLine(line: string): Array<{ type: string; [key: string]: unknown }> {
  const record = JSON.parse(line);
  if (record.type === "branch_append" || record.type === "branch_select") {
    const entries = record.type === "branch_append" ? record.entries : record.settlements;
    return entries.map((entry: { parentId: string; item: { type: string } }) => ({ ...entry.item, parentId: entry.parentId }));
  }
  return [record];
}
