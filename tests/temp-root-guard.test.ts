import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertRemovableTempRoot, makeTempRoot, removeTempRoot, withIsolatedCliDirs, withTempDir } from "./helpers.ts";

const exists = (path: string) => stat(path).then(() => true, () => false);

test("a temp root sits directly in the OS temp directory and its removal deletes only that root", async () => {
  const root = await makeTempRoot("schway-guard-");
  const sibling = await realpath(await mkdtemp(join(tmpdir(), "schway-guard-sibling-")));
  try {
    expect(dirname(root)).toBe(await realpath(tmpdir()));
    await mkdir(join(root, "nested/deeper"), { recursive: true });
    await writeFile(join(root, "nested/deeper/file"), "x");
    await removeTempRoot(root);
    expect(await exists(root)).toBe(false);
    expect(await exists(sibling)).toBe(true);
    // A removed root is no longer owned, so a second removal can't reach a reused name.
    expect(() => assertRemovableTempRoot(root)).toThrow("not a temporary root this test process created");
  } finally { await rm(sibling, { recursive: true, force: true }); }
});

test("recursive removal refuses paths outside a root this process created", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "schway-guard-outside-")));
  try {
    const root = await makeTempRoot("schway-guard-");
    try {
      for (const path of [outside, join(root, "nested"), join(root, ".."), `${root}/`, tmpdir(), dirname(root), process.cwd(),
        resolve(import.meta.dir, ".."), homedir(), "/", "relative/path", ""]) {
        await expect(removeTempRoot(path)).rejects.toThrow("Refusing to remove");
      }
      expect(await exists(outside)).toBe(true);
      expect(await exists(root)).toBe(true);
    } finally { await removeTempRoot(root); }
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a root that would contain the working directory is never removed", async () => {
  const root = await makeTempRoot("schway-guard-");
  const cwd = process.cwd();
  try {
    process.chdir(root);
    expect(() => assertRemovableTempRoot(root)).toThrow(`it contains ${root}`);
    await mkdir(join(root, "inner"));
    process.chdir(join(root, "inner"));
    await expect(removeTempRoot(root)).rejects.toThrow("Refusing to remove");
    expect(await exists(join(root, "inner"))).toBe(true);
  } finally {
    process.chdir(cwd);
    await removeTempRoot(root);
  }
  expect(await exists(root)).toBe(false);
});

test("shared fixture helpers remove their roots through the guard", async () => {
  let seen = "";
  await withTempDir(async dir => {
    seen = dir;
    expect(() => assertRemovableTempRoot(dir)).not.toThrow();
  });
  expect(await exists(seen)).toBe(false);
  await withIsolatedCliDirs(async dirs => {
    seen = dirs.root;
    expect(() => assertRemovableTempRoot(dirs.root)).not.toThrow();
    expect(() => assertRemovableTempRoot(dirs.home)).toThrow("not a temporary root");
  });
  expect(await exists(seen)).toBe(false);
});
