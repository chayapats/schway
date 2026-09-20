import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
