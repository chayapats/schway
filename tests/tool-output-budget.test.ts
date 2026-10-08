import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { executeToolCall } from "../src/tools/executor.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength, utf8Prefix } from "../src/tools/output-budget.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

test("utf8ByteLength counts UTF-8 bytes, not UTF-16 units", () => {
  expect(utf8ByteLength("abc")).toBe(3);
  expect(utf8ByteLength("ก")).toBe(3);
  expect(utf8ByteLength("é")).toBe(2);
  expect(utf8ByteLength("🙂")).toBe(4);
  expect(utf8ByteLength("\ud83d")).toBe(3);
});

test("utf8Prefix keeps the longest prefix that fits without splitting a code point", () => {
  expect(utf8Prefix("abc", 3)).toBe("abc");
  expect(utf8Prefix("abc", 2)).toBe("ab");
  expect(utf8Prefix("abc", 0)).toBe("");
  expect(utf8Prefix("aกb", 3)).toBe("a");
  expect(utf8Prefix("aกb", 4)).toBe("aก");
  expect(utf8Prefix("🙂🙂", 7)).toBe("🙂");
  expect(utf8Prefix("a🙂", 4)).toBe("a");
  expect(utf8Prefix("aé", 2)).toBe("a");
  // A lone surrogate counts as its 3-byte replacement encoding and is never paired with a neighbour.
  expect(utf8Prefix("\ud83dx", 3)).toBe("\ud83d");
  const long = "ก".repeat(20_000);
  const cut = utf8Prefix(long, TOOL_OUTPUT_BUDGET_BYTES);
  expect(cut).toBe("ก".repeat(16_666));
  expect(utf8ByteLength(cut)).toBeLessThanOrEqual(TOOL_OUTPUT_BUDGET_BYTES);
});

test("executor error results are bounded by UTF-8 bytes on a code-point boundary", async () => {
  const failing: ToolDefinition<Record<string, never>> = {
    name: "fail",
    description: "Always fails with a long non-ASCII message.",
    inputSchema: Type.Object({}, { additionalProperties: false }),
    effect: "read-only",
    execution: "parallel",
    async execute() {
      // 20,000 UTF-16 units: under the old 50,000-unit cap, but 60,000 UTF-8 bytes.
      throw new Error(`a${"ก".repeat(19_999)}`);
    },
  };
  const root = process.cwd();
  const executed = await executeToolCall({
    registry: createToolRegistry([failing]),
    workspace: { root, launchCwd: root, extraRoots: [] },
    call: { type: "tool_call", id: "call", name: "fail", arguments: {} },
  });
  expect(executed.status).toBe("error");
  const content = executed.result.content;
  expect(utf8ByteLength(content)).toBeLessThanOrEqual(TOOL_OUTPUT_BUDGET_BYTES);
  expect(utf8ByteLength(content)).toBeGreaterThan(TOOL_OUTPUT_BUDGET_BYTES - 3);
  expect(content).toStartWith("aก");
  expect(content).toEndWith("\n[Tool output truncated; narrow the request or use pagination.]");
  expect(content.isWellFormed()).toBe(true);
  expect(content.includes("�")).toBe(false);
});
