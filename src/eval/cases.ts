import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Seed, allowed paths, and independent checks for one bounded coding scenario. */
export interface EvalCase {
  id: string;
  version: number;
  task: string;
  seed: Readonly<Record<string, string>>;
  writable: readonly string[];
  verifyCommand?: string;
  verifyFile?: string;
  /** Check only bounded candidate files copied out of the isolated workspace. */
  check(files: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv, signal: AbortSignal): boolean | Promise<boolean>;
  /** Bounded expected-versus-observed diagnostics with unknown candidate values redacted. */
  diagnose(files: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv, signal: AbortSignal): string | Promise<string>;
  /** Older complete turns supplied to the real context manager for the compaction case. */
  history?: readonly string[];
  contextWindow?: number;
}

function answer(files: Readonly<Record<string, string>>, expected: Record<string, unknown>): boolean {
  try {
    const parsed: unknown = JSON.parse(files["answer.json"] ?? "");
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => (parsed as Record<string, unknown>)[key] === value);
  } catch { return false; }
}

function diagnose(expected: Record<string, unknown> | readonly unknown[], observed: unknown): string {
  const known = new Set([...Object.values(expected), "src/preview.ts", "src/logger.ts", "preview", "fallback", "health", "MARY", "ADA LOVELACE", "LIN CHEN"]);
  const safe = (value: unknown): unknown => known.has(value) || typeof value === "number" && Number.isSafeInteger(value) && value >= -100 && value <= 100 ? value : "[redacted]";
  const actual = Array.isArray(observed) ? observed.slice(0, 8).map(safe) : observed && typeof observed === "object" && !Array.isArray(observed) ?
    Object.fromEntries(Object.keys(expected).map(key => [key, safe((observed as Record<string, unknown>)[key])])) : "[redacted]";
  return JSON.stringify({ expected, actual }).slice(0, 1024);
}

function answerEvidence(files: Readonly<Record<string, string>>, expected: Record<string, unknown>): string {
  try { return diagnose(expected, JSON.parse(files["answer.json"] ?? "")); }
  catch { return diagnose(expected, null); }
}

async function codeEvidence(files: Readonly<Record<string, string>>, paths: string[], expression: string, expected: readonly unknown[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  try { return diagnose(expected, JSON.parse(String(await evaluate(files, paths, expression, env, signal)))); }
  catch { return diagnose(expected, null); }
}

async function evaluate(files: Readonly<Record<string, string>>, paths: string[], expression: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<unknown> {
  const javascript = paths.map(path => new Bun.Transpiler({ loader: "ts" }).transformSync(files[path]!)
    .replace(/^\s*import .*?;\s*$/gm, "").replace(/^\s*export\s+/gm, "")).join("\n");
  // Bun's node:vm is not a security boundary and does not implement its timeout.
  // The child has no provider credentials and an OS-level deadline/output cap.
  const source = `import { runInNewContext } from "node:vm";\nconst value = runInNewContext(${JSON.stringify(`${javascript}\n${expression}`)}, {}, { timeout: 250 });\nconsole.log(JSON.stringify(value));`;
  const result = await exec("bun", ["--no-env-file", "-e", source], {
    cwd: env.HOME, env, timeout: 1000, maxBuffer: 2048, signal,
  });
  return JSON.parse(result.stdout.trim()) as unknown;
}

const refactorSeed = {
  "src/normalize.ts": "export function normalizeName(value: string): string { return value.trim(); }\n",
  "src/display.ts": 'import { normalizeName } from "./normalize.ts";\nexport function displayName(value: string): string { return normalizeName(value).toUpperCase(); }\n',
  "test/display.test.ts": 'import { test, expect } from "bun:test";\nimport { displayName } from "../src/display.ts";\nimport { normalizeName } from "../src/normalize.ts";\ntest("normalization", () => expect(normalizeName("  Ada   Lovelace ")).toBe("Ada Lovelace"));\ntest("caller preserves casing", () => expect(displayName("Lin  Chen")).toBe("Lin Chen"));\n',
};
const cartSeed = {
  "src/cart.ts": "export function cartTotal(items: { price: number; quantity: number }[]): number { return items.reduce((sum, item) => sum + item.price, 0); }\n",
  "test/cart.test.ts": 'import { test, expect } from "bun:test";\nimport { cartTotal } from "../src/cart.ts";\ntest("quantities", () => expect(cartTotal([{ price: 7, quantity: 2 }, { price: 3, quantity: 1 }])).toBe(17));\ntest("empty", () => expect(cartTotal([])).toBe(0));\n',
};
const REFACTOR_PROBE = 'JSON.stringify([normalizeName("  Ada   Lovelace "), normalizeName("Lin  Chen"), displayName("  Ada   Lovelace "), displayName("Lin  Chen"), displayName("  MARY  ")])';
const REFACTOR_EXPECTED = ["Ada Lovelace", "Lin Chen", "Ada Lovelace", "Lin Chen", "MARY"];
const CART_PROBE = "JSON.stringify([cartTotal([{price:7,quantity:2},{price:3,quantity:1}]),cartTotal([]),cartTotal([{price:4,quantity:0}]),cartTotal([{price:2,quantity:3}])])";
const CART_EXPECTED = [17, 0, 0, 6];
const history = [
  "This repository's release codename is amber. Keep that fact for the final manifest.",
  "The release channel must be stable, not preview. This constraint is permanent.",
  ...Array.from({ length: 11 }, (_, index) => `Completed investigation ${index + 1}: no source changes are needed yet. ${"Routine notes. ".repeat(45)}`),
];

/** Additional daily-driver cases graded against isolated repository state, not model prose. */
export const DAILY_CASES: readonly EvalCase[] = [
  {
    id: "multi-file-refactor", version: 1,
    task: "Refactor normalizeName and its displayName caller to collapse internal whitespace while preserving name casing. Keep the provided test and run bun test test/display.test.ts.",
    seed: refactorSeed, writable: ["src/normalize.ts", "src/display.ts"], verifyCommand: "bun test test/display.test.ts", verifyFile: "test/display.test.ts",
    check: async (files, env, signal) => {
      try {
        return ["src/normalize.ts", "src/display.ts"].every(path => files[path] !== refactorSeed[path as keyof typeof refactorSeed]) &&
          await evaluate(files, ["src/normalize.ts", "src/display.ts"], REFACTOR_PROBE, env, signal) === JSON.stringify(REFACTOR_EXPECTED);
      } catch { return false; }
    },
    diagnose: (files, env, signal) => codeEvidence(files, ["src/normalize.ts", "src/display.ts"], REFACTOR_PROBE, REFACTOR_EXPECTED, env, signal),
  },
  {
    id: "locate-implementation", version: 1,
    task: 'Find the implementation that selects the active HTTP route (not the logging/preview lookalikes). Read the candidate files and write answer.json with {"path":"...","symbol":"..."}.',
    seed: {
      "src/router.ts": 'export function resolveRoute(path: string) { return path === "/health" ? "health" : "fallback"; }\n',
      "src/preview.ts": 'export function resolveRoute(path: string) { return `preview:${path}`; }\n',
      "src/logger.ts": 'export function logRoute(path: string) { return `visited:${path}`; }\n',
      "src/server.ts": 'import { resolveRoute } from "./router.ts";\nexport const handleRequest = (path: string) => resolveRoute(path);\n',
      "answer.json": "{}\n",
    }, writable: ["answer.json"],
    check: files => answer(files, { path: "src/router.ts", symbol: "resolveRoute" }),
    diagnose: files => answerEvidence(files, { path: "src/router.ts", symbol: "resolveRoute" }),
  },
  {
    id: "failing-tests", version: 1,
    task: "Diagnose the failing cart tests, fix the real quantity behavior without editing or disabling the tests, then run bun test test/cart.test.ts.",
    seed: cartSeed, writable: ["src/cart.ts"], verifyCommand: "bun test test/cart.test.ts", verifyFile: "test/cart.test.ts",
    check: async (files, env, signal) => {
      try {
        return files["src/cart.ts"] !== cartSeed["src/cart.ts"] &&
          await evaluate(files, ["src/cart.ts"], CART_PROBE, env, signal) === JSON.stringify(CART_EXPECTED);
      } catch { return false; }
    },
    diagnose: (files, env, signal) => codeEvidence(files, ["src/cart.ts"], CART_PROBE, CART_EXPECTED, env, signal),
  },
  {
    id: "long-context", version: 1,
    task: 'Use the release codename and channel from the older conversation turns to write answer.json as {"codename":"...","channel":"..."}. Do not guess from the current turn.',
    seed: { "answer.json": "{}\n", "README.md": "Release manifest must reflect prior discussion.\n" }, writable: ["answer.json"],
    history, contextWindow: 2500,
    check: files => answer(files, { codename: "amber", channel: "stable" }),
    diagnose: files => answerEvidence(files, { codename: "amber", channel: "stable" }),
  },
  {
    id: "tool-error-recovery", version: 1,
    task: 'The old target src/missing-config.ts is gone. If reading it fails, locate the valid config at src/config.ts and write answer.json with its region and revision.',
    seed: { "src/config.ts": 'export const config = { region: "ap-south", revision: 7 };\n', "README.md": "Configuration moved to src/config.ts.\n", "answer.json": "{}\n" },
    writable: ["answer.json"], check: files => answer(files, { region: "ap-south", revision: 7 }),
    diagnose: files => answerEvidence(files, { region: "ap-south", revision: 7 }),
  },
  {
    id: "parallel-read", version: 1,
    task: 'Read all three independent input files (they can be read in parallel). Write answer.json with the customer, sku, and quantity from their contents. Timing alone is never a grade.',
    seed: { "input/customer.txt": "customer=mina\n", "input/item.txt": "sku=Q42\n", "input/count.txt": "quantity=3\n", "answer.json": "{}\n" },
    writable: ["answer.json"], check: files => answer(files, { customer: "mina", sku: "Q42", quantity: 3 }),
    diagnose: files => answerEvidence(files, { customer: "mina", sku: "Q42", quantity: 3 }),
  },
];

