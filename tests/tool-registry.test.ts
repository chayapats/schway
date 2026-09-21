import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { editTool } from "../src/tools/edit.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { writeTool } from "../src/tools/write.ts";

/** Minimal tool used to exercise schema registration. */
function stub(schema: unknown): ToolDefinition {
  return {
    name: "stub",
    description: "stub",
    inputSchema: schema as ToolDefinition["inputSchema"],
    execution: "parallel",
    execute: async () => ({ content: "ok" }),
  };
}

test("registers TypeBox schemas and validates arguments before execution", () => {
  const registry = createToolRegistry([
    readTool,
    writeTool,
    editTool,
    grepTool,
    findTool,
    lsTool,
  ]);
  const registered = registry.get("read");
  expect(registered).toBeDefined();
  expect(registered?.validate({ path: "a.ts" }).ok).toBe(true);
  const invalid = registered?.validate({ path: 1 });
  expect(invalid?.ok).toBe(false);
  if (invalid?.ok !== false) {
    throw new Error("expected invalid arguments");
  }
  expect(invalid.message).toContain("path");
  expect(registry.get("write")?.validate({ path: "a.ts", content: "x" }).ok).toBe(
    true,
  );
  expect(
    registry.get("edit")?.validate({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    }).ok,
  ).toBe(true);
  expect(
    registry.get("edit")?.validate({
      path: "a.ts",
      edits: [{ oldText: "", newText: "b" }],
    }).ok,
  ).toBe(false);
  expect(registry.get("grep")?.validate({ pattern: "foo" }).ok).toBe(true);
  expect(registry.get("grep")?.validate({ pattern: 1 }).ok).toBe(false);
  expect(registry.get("find")?.validate({ pattern: "**/*.ts" }).ok).toBe(true);
  expect(registry.get("find")?.validate({}).ok).toBe(false);
  expect(registry.get("ls")?.validate({}).ok).toBe(true);
  expect(registry.get("ls")?.validate({ depth: 0 }).ok).toBe(false);
  expect(grepTool.execution).toBe("parallel");
  expect(findTool.execution).toBe("parallel");
  expect(lsTool.execution).toBe("parallel");
});

test("unsupported schemas fail early with an actionable error", () => {
  expect(() =>
    createToolRegistry([
      stub({
        type: "object",
        properties: {
          target: { $ref: "#/$defs/file" },
        },
      }),
    ]),
  ).toThrow(/Unsupported JSON Schema keyword "\$ref"/);
});

test("compiles validators once at registration", () => {
  const schema = Type.Object({ name: Type.String() });
  const registry = createToolRegistry([stub(schema)]);
  const first = registry.get("stub")?.validate;
  const second = registry.get("stub")?.validate;
  expect(first).toBe(second);
});
