import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One normalized tool outcome: model-facing content, error flag and structured details. */
interface Outcome { tool: string; input: unknown; content: string; isError: boolean; details: unknown; spill?: string }

type Execute = (input: unknown, ctx: { workspace: { root: string; launchCwd: string; extraRoots: string[] } }) =>
  Promise<{ content: string; isError?: boolean; details?: unknown }>;

/**
 * Run the core-tool parity fixtures through either the CLI's built-in definitions (`cli`) or
 * `coreToolDefinitions(localExecutionBackend(root))` (`host`), normalizing temporary paths and UUIDs.
 * The committed golden was recorded from the CLI definitions before the execution-backend refactor.
 */
export async function runParityFixtures(mode: "cli" | "host"): Promise<Outcome[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "schway-parity-")));
  try {
    await seed(root);
    const tools = await load(mode, root);
    const ctx = { workspace: { root, launchCwd: root, extraRoots: [] } };
    const temp = await realpath(tmpdir());
    const normalize = (text: string) => digest(text
      .replaceAll(root, "<root>").replaceAll(temp, "<tmp>").replaceAll(tmpdir(), "<tmp>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"));
    const outcomes: Outcome[] = [];
    for (const [tool, input] of CASES) {
      const result = await tools[tool]!(input, ctx);
      const details = result.details as { outputPath?: string } | undefined;
      const spill = details?.outputPath ? await readFile(details.outputPath, "utf8") : undefined;
      if (details?.outputPath) {
        // The spill must also be readable through the same tool family.
        const reread = await tools.read!({ path: details.outputPath, offset: 3, limit: 2 }, ctx);
        outcomes.push({ tool: "read", input: { path: "<spill>", offset: 3, limit: 2 }, content: normalize(reread.content),
          isError: reread.isError === true, details: normalizeValue(reread.details ?? null, normalize) });
      }
      outcomes.push({
        tool, input, content: normalize(result.content), isError: result.isError === true,
        details: normalizeValue(result.details ?? null, normalize),
        ...(spill === undefined ? {} : { spill: normalize(spill) }),
      });
    }
    return outcomes;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Keep short text readable and replace long text with its SHA-256 and UTF-8 byte length. */
function digest(text: string): string {
  if (text.length <= 512) return text;
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return `<sha256:${hash} bytes:${Buffer.byteLength(text)} head:${JSON.stringify(text.slice(0, 40))} tail:${JSON.stringify(text.slice(-180))}>`;
}

/** Normalize every string inside a JSON-compatible value. */
function normalizeValue(value: unknown, normalize: (text: string) => string): unknown {
  if (typeof value === "string") return normalize(value);
  if (Array.isArray(value)) return value.map(item => normalizeValue(item, normalize));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item, normalize)]));
  }
  return value;
}

async function load(mode: "cli" | "host", root: string): Promise<Record<string, Execute>> {
  if (mode === "host") {
    const { coreToolDefinitions, localExecutionBackend } = await import("../../src/host/index.ts");
    return Object.fromEntries(coreToolDefinitions(localExecutionBackend(root)).map(tool => [tool.name, tool.execute.bind(tool) as Execute]));
  }
  const modules = await Promise.all(["read", "write", "edit", "bash", "grep", "find", "ls"].map(async name =>
    [name, (await import(`../../src/tools/${name}.ts`))[`${name}Tool`] as { execute: Execute }] as const));
  return Object.fromEntries(modules.map(([name, tool]) => [name, tool.execute.bind(tool)]));
}

async function seed(root: string): Promise<void> {
  await mkdir(join(root, "src/nested"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "a.txt"), "hello\nworld\nthird line\n");
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(join(root, "thai.txt"), `${"ภาษาไทย🙂".repeat(6000)}\nshort\n`);
  await writeFile(join(root, "many.txt"), Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"));
  await writeFile(join(root, "src/x.ts"), "export const needle = 1;\nexport const other = 2;\n");
  await writeFile(join(root, "src/y.ts"), "// Needle in caps\nconst needle = 3;\n");
  await writeFile(join(root, "src/nested/z.ts"), "needle();\n");
  await writeFile(join(root, "docs/readme.md"), "needle docs\n");
  await writeFile(join(root, "edit.txt"), "alpha\nbeta\ngamma\nbeta-two\n");
  await writeFile(join(root, "replace.txt"), "old contents\n");
  await symlink(join(root, "src"), join(root, "src-link"));
}

const CASES: Array<[string, unknown]> = [
  ["read", { path: "a.txt" }],
  ["read", { path: "a.txt", offset: 2, limit: 1 }],
  ["read", { path: "many.txt" }],
  ["read", { path: "thai.txt" }],
  ["read", { path: "empty.txt" }],
  ["read", { path: "bin.dat" }],
  ["read", { path: "missing.txt" }],
  ["read", { path: "src" }],
  ["read", { path: "a.txt", offset: 99 }],
  ["read", { path: "src-link/x.ts" }],
  ["write", { path: "created/new.txt", content: "one\ntwo\n" }],
  ["write", { path: "replace.txt", content: "new contents" }],
  ["write", { path: "src", content: "x" }],
  ["read", { path: "created/new.txt" }],
  ["edit", { path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma", newText: "GAMMA" }] }],
  ["edit", { path: "edit.txt", edits: [{ oldText: "missing", newText: "x" }] }],
  ["edit", { path: "edit.txt", edits: [{ oldText: "beta", newText: "x" }] }],
  ["edit", { path: "edit.txt", edits: [{ oldText: "ALPHA\nbeta", newText: "x" }, { oldText: "beta\nGAMMA", newText: "y" }] }],
  ["edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }],
  ["read", { path: "edit.txt" }],
  ["bash", { command: "printf 'out\\n'; printf 'err\\n' >&2" }],
  ["bash", { command: "echo failing; exit 3" }],
  ["bash", { command: "pwd", cwd: "src" }],
  ["bash", { command: "for i in $(seq 8000); do printf 'ASCII ภาษาไทย 🙂 '; done; printf 'tail-err' >&2" }],
  ["bash", { command: "sleep 5", timeout: 100 }],
  // Ripgrep orders multi-file results nondeterministically, so each search matches one file.
  ["grep", { pattern: "needle", path: "docs" }],
  ["grep", { pattern: "needle", path: "src/nested", glob: "*.ts" }],
  ["grep", { pattern: "NEEDLE", ignoreCase: true, path: "src/y.ts" }],
  ["grep", { pattern: "line [0-9]+", path: "many.txt", maxResults: 2 }],
  ["grep", { pattern: "absent-token" }],
  ["grep", { pattern: "needle", path: "missing" }],
  ["find", { pattern: "**/*.ts" }],
  ["find", { pattern: "*.md", path: "docs" }],
  ["find", { pattern: "**/*.none" }],
  ["find", { pattern: "*", path: "a.txt" }],
  ["find", { pattern: "*", path: "missing" }],
  ["ls", {}],
  ["ls", { path: "src", depth: 2 }],
  ["ls", { path: "a.txt" }],
  ["ls", { path: "missing" }],
];

if (import.meta.main) {
  const mode = process.argv[2] === "host" ? "host" : "cli";
  console.log(JSON.stringify(await runParityFixtures(mode), null, 2));
}
