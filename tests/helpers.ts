import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "schway-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  const root = await mkdtemp(join(tmpdir(), "schway-cli-"));
  try {
    const home = join(root, "home");
    const work = join(root, "work");
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    const sentinelContent = `sentinel-${crypto.randomUUID()}`;
    const sentinelPath = join(root, "sentinel.txt");
    await writeFile(sentinelPath, sentinelContent, "utf8");
    await fn({ root, home, work, sentinelPath, sentinelContent });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    let entries: string[] | undefined;
    try {
      entries = await readdir(outside);
    } catch {
      entries = undefined;
    }
    if (entries !== undefined && entries.length > 0) {
      throw new Error(`Isolated CLI run wrote user state outside HOME: ${outside}`);
    }
  }
  let sessions: string[] | undefined;
  try {
    sessions = await readdir(join(dirs.home, ".schway", "sessions"));
  } catch {
    sessions = undefined;
  }
  if (sessions !== undefined && sessions.length > 0) {
    throw new Error("Isolated CLI run created sessions on an early-failure path");
  }
}
