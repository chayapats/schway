import { expect, test } from "bun:test";
import { mkdirSync, rmdirSync } from "node:fs";
import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertRemovableOwnedTree, assertRemovableTempRoot, makeTempRoot, makeTempRootSync, removeOwnedTree, removeOwnedTreeSync,
  removeTempRoot, removeTempRootSync, withIsolatedCliDirs, withTempDir,
} from "./helpers.ts";
import { countTempSites, findTempSites, scanTempSites, type TempSiteKind } from "./helpers/temp-root-sites.ts";

const repo = resolve(import.meta.dir, "..");
const exists = (path: string) => stat(path).then(() => true, () => false);

test("a temp root sits directly in the OS temp directory and its removal deletes only that root", async () => {
  const root = await makeTempRoot("schway-guard-");
  const sibling = await makeTempRoot("schway-guard-sibling-");
  try {
    expect(dirname(root)).toBe(await realpath(tmpdir()));
    await mkdir(join(root, "nested/deeper"), { recursive: true });
    await writeFile(join(root, "nested/deeper/file"), "x");
    await removeTempRoot(root);
    expect(await exists(root)).toBe(false);
    expect(await exists(sibling)).toBe(true);
    // A removed root is no longer owned, so a second removal can't reach a reused name.
    expect(() => assertRemovableTempRoot(root)).toThrow("not a temporary root this test process created");
  } finally { await removeTempRoot(sibling); }
  const sync = makeTempRootSync("schway-guard-sync-");
  mkdirSync(join(sync, "inner"));
  removeTempRootSync(sync);
  expect(await exists(sync)).toBe(false);
});

test("recursive removal refuses paths outside a root this process created", async () => {
  const other = await makeTempRoot("schway-guard-other-");
  const root = await makeTempRoot("schway-guard-");
  try {
    for (const path of [join(other, "inside"), join(root, "nested"), join(root, ".."), `${root}/`, tmpdir(), dirname(root), process.cwd(),
      repo, homedir(), "/", "relative/path", ""]) {
      await expect(removeTempRoot(path)).rejects.toThrow("Refusing to remove");
    }
    expect(await exists(other)).toBe(true);
    expect(await exists(root)).toBe(true);
  } finally { await removeTempRoot(root); await removeTempRoot(other); }
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

test("a deleted working directory doesn't block later removals", async () => {
  const root = await makeTempRoot("schway-guard-");
  const other = await makeTempRoot("schway-guard-other-");
  const cwd = process.cwd();
  try {
    mkdirSync(join(root, "gone"));
    process.chdir(join(root, "gone"));
    rmdirSync(join(root, "gone"));
    await removeTempRoot(other);
    await removeTempRoot(root);
    expect(await exists(other)).toBe(false);
    expect(await exists(root)).toBe(false);
  } finally { process.chdir(cwd); }
});

test("the working-directory check sees through letter case and links", async () => {
  const root = await makeTempRoot("schway-guard-");
  const cwd = process.cwd();
  try {
    await mkdir(join(root, "Work"));
    process.chdir(join(root, "Work"));
    if (await exists(join(root, "work"))) {
      // Case-insensitive volume (macOS default): root/work is the working directory.
      await expect(removeOwnedTree(root, join(root, "work"))).rejects.toThrow(`it contains ${join(root, "Work")}`);
      expect(() => assertRemovableOwnedTree(root, join(root, "WORK"))).toThrow("it contains");
    } else {
      // Case-sensitive volume: root/work is another, missing directory, so removing it is a no-op.
      await removeOwnedTree(root, join(root, "work"));
    }
    expect(await exists(join(root, "Work"))).toBe(true);
    // A link to the working directory is removed as a link; the directory stays.
    await symlink(join(root, "Work"), join(root, "alias"));
    await removeOwnedTree(root, join(root, "alias"));
    expect(await exists(join(root, "Work"))).toBe(true);
  } finally {
    process.chdir(cwd);
    await removeTempRoot(root);
  }
});

test("owned-tree removal deletes only paths strictly inside the root, never through a symlink", async () => {
  const root = await makeTempRoot("schway-guard-");
  const outside = await makeTempRoot("schway-guard-outside-");
  try {
    await mkdir(join(root, "a/b"), { recursive: true });
    await writeFile(join(root, "a/b/file"), "x");
    await writeFile(join(outside, "victim"), "keep");
    await symlink(outside, join(root, "link"));
    await removeOwnedTree(root, join(root, "a"));
    expect(await exists(join(root, "a"))).toBe(false);
    for (const path of [root, `${root}/`, join(root, "link/victim"), join(root, "a/../../x"), join(outside, "victim"), "a/b", tmpdir()]) {
      expect(() => assertRemovableOwnedTree(root, path), path).toThrow("Refusing to remove");
    }
    expect(() => assertRemovableOwnedTree(outside, join(root, "nested"))).toThrow("not strictly inside");
    expect(() => assertRemovableOwnedTree(join(root, "a"), join(root, "a/b"))).toThrow("is not a temporary root this test process created");
    // A final symlink is removed itself; its target survives.
    removeOwnedTreeSync(root, join(root, "link"));
    expect(await exists(join(root, "link"))).toBe(false);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("keep");
    // A missing path inside the root is a no-op, like rm with force.
    await removeOwnedTree(root, join(root, "missing/deeper"));
  } finally { await removeTempRoot(root); await removeTempRoot(outside); }
});

test("a cleanup refusal keeps the callback's own error and attaches the refusal as its cause", async () => {
  const cwd = process.cwd();
  const seen: string[] = [];
  try {
    const failure = await withTempDir(async dir => {
      seen.push(dir);
      process.chdir(dir);
      throw new Error("callback failed");
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("callback failed");
    expect(String(((failure as Error).cause as Error).message)).toContain("Refusing to remove");
    const thrown = await withTempDir(async dir => {
      seen.push(dir);
      process.chdir(dir);
      throw "not an Error";
    }).then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBe("not an Error");
    // With no callback error, the refusal itself is thrown.
    const refused = await withTempDir(async dir => { seen.push(dir); process.chdir(dir); }).then(() => undefined, (error: unknown) => error);
    expect(String((refused as Error).message)).toContain("Refusing to remove");
  } finally {
    process.chdir(cwd);
    for (const dir of seen) await removeTempRoot(dir);
  }
  expect(seen).toHaveLength(3);
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

test("the scanner finds direct recursive removals and mkdtemp calls, including aliases, argv lists and shell forms", async () => {
  const source = await Bun.file(join(import.meta.dir, "fixtures/temp-root-sites.txt")).text();
  expect(findTempSites("tests/x.test.ts", source).map(site => `${site.line}:${site.kind}`)).toEqual([
    "2:recursiveRemoval", "4:recursiveRemoval", "7:recursiveRemoval", "9:mkdtemp", "10:mkdtemp", "11:recursiveRemoval",
    "12:recursiveRemoval", "16:recursiveRemoval", "18:mkdtemp", "19:mkdtemp", "20:recursiveRemoval", "21:recursiveRemoval",
    "22:recursiveRemoval", "24:recursiveRemoval", "25:recursiveRemoval", "26:recursiveRemoval", "27:recursiveRemoval",
  ]);
  // Every line the fixture marks as counted is found, and nothing else.
  const marked = source.split("\n").flatMap((line, index) => / \/\/ counted/.test(line) ? [index + 1] : []);
  expect([...new Set(findTempSites("tests/x.test.ts", source).map(site => site.line))]).toEqual(marked);
});

test("direct recursive removal and mkdtemp sites under tests/ match the allowlist exactly", async () => {
  // Existing sites are allowlisted until they move to makeTempRoot, removeTempRoot and removeOwnedTree.
  // A new site fails: use the guarded helpers instead. A migrated site fails until its entry is lowered,
  // so the ratchet never keeps slack.
  const allowlistPath = "tests/fixtures/temp-root-allowlist.json";
  const allowlist = await Bun.file(join(repo, allowlistPath)).json() as Record<string, Partial<Record<TempSiteKind, number>>>;
  expect(Object.keys(allowlist)).toEqual(Object.keys(allowlist).sort());
  const sites = await scanTempSites(repo);
  const counts = countTempSites(sites);
  const problems: string[] = [];
  for (const file of [...new Set([...Object.keys(counts), ...Object.keys(allowlist)])].sort()) {
    for (const kind of ["mkdtemp", "recursiveRemoval"] as const) {
      const actual = counts[file]?.[kind] ?? 0, allowed = allowlist[file]?.[kind];
      if (allowed !== undefined && (!Number.isInteger(allowed) || allowed < 1)) problems.push(`${allowlistPath}: ${file} ${kind} must be a positive count or absent`);
      if (actual > (allowed ?? 0)) {
        const lines = sites.filter(site => site.file === file && site.kind === kind).map(site => site.line);
        problems.push(`${file}: ${actual} ${kind} sites, ${allowed ?? 0} allowed (lines ${lines.join(", ")}). Use makeTempRoot, removeTempRoot or removeOwnedTree from tests/helpers.ts instead.`);
      } else if (actual < (allowed ?? 0)) {
        problems.push(`${file}: ${actual} ${kind} sites, ${allowed} allowed. Lower ${file} ${kind} in ${allowlistPath} to ${actual}${actual === 0 ? " by removing it" : ""}.`);
      }
    }
  }
  expect(problems).toEqual([]);
});
