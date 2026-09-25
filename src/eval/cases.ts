import { runInNewContext } from "node:vm";

/** Seed, allowed paths, and independent checks for one bounded coding scenario. */
export interface EvalCase {
  id: string;
  version: number;
  task: string;
  seed: Readonly<Record<string, string>>;
  writable: readonly string[];
  verifyCommand?: string;
  /** Check only bounded candidate files copied out of the isolated workspace. */
  check(files: Readonly<Record<string, string>>): boolean;
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

function evaluate(files: Readonly<Record<string, string>>, paths: string[], expression: string): unknown {
  const javascript = paths.map(path => new Bun.Transpiler({ loader: "ts" }).transformSync(files[path]!)
    .replace(/^\s*import .*?;\s*$/gm, "").replace(/^\s*export\s+/gm, "")).join("\n");
  return runInNewContext(`${javascript}\n${expression}`, {}, { timeout: 250 });
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
    seed: refactorSeed, writable: ["src/normalize.ts", "src/display.ts"], verifyCommand: "bun test test/display.test.ts",
    check: files => {
      try {
        return ["src/normalize.ts", "src/display.ts"].every(path => files[path] !== refactorSeed[path as keyof typeof refactorSeed]) &&
          evaluate(files, ["src/normalize.ts", "src/display.ts"], 'JSON.stringify([displayName("  Ada   Lovelace "), displayName("Lin  Chen"), displayName("  MARY  ")])') === '["Ada Lovelace","Lin Chen","MARY"]';
      } catch { return false; }
    },
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
  },
  {
    id: "failing-tests", version: 1,
    task: "Diagnose the failing cart tests, fix the real quantity behavior without editing or disabling the tests, then run bun test test/cart.test.ts.",
    seed: cartSeed, writable: ["src/cart.ts"], verifyCommand: "bun test test/cart.test.ts",
    check: files => {
      try {
        return files["src/cart.ts"] !== cartSeed["src/cart.ts"] &&
          evaluate(files, ["src/cart.ts"], "JSON.stringify([cartTotal([{price:7,quantity:2},{price:3,quantity:1}]),cartTotal([]),cartTotal([{price:4,quantity:0}]),cartTotal([{price:2,quantity:3}])])") === "[17,0,0,6]";
      } catch { return false; }
    },
  },
  {
    id: "long-context", version: 1,
    task: 'Use the release codename and channel from the older conversation turns to write answer.json as {"codename":"...","channel":"..."}. Do not guess from the current turn.',
    seed: { "answer.json": "{}\n", "README.md": "Release manifest must reflect prior discussion.\n" }, writable: ["answer.json"],
    history, contextWindow: 2500,
    check: files => answer(files, { codename: "amber", channel: "stable" }),
  },
  {
    id: "tool-error-recovery", version: 1,
    task: 'The old target src/missing-config.ts is gone. If reading it fails, locate the valid config at src/config.ts and write answer.json with its region and revision.',
    seed: { "src/config.ts": 'export const config = { region: "ap-south", revision: 7 };\n', "README.md": "Configuration moved to src/config.ts.\n", "answer.json": "{}\n" },
    writable: ["answer.json"], check: files => answer(files, { region: "ap-south", revision: 7 }),
  },
  {
    id: "parallel-read", version: 1,
    task: 'Read all three independent input files (they can be read in parallel). Write answer.json with the customer, sku, and quantity from their contents. Timing alone is never a grade.',
    seed: { "input/customer.txt": "customer=mina\n", "input/item.txt": "sku=Q42\n", "input/count.txt": "quantity=3\n", "answer.json": "{}\n" },
    writable: ["answer.json"], check: files => answer(files, { customer: "mina", sku: "Q42", quantity: 3 }),
  },
];

