import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

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
  const registry = createToolRegistry([readTool]);
  const registered = registry.get("read");
  expect(registered).toBeDefined();
  expect(registered?.validate({ path: "a.ts" }).ok).toBe(true);
  const invalid = registered?.validate({ path: 1 });
  expect(invalid?.ok).toBe(false);
  if (invalid?.ok !== false) {
    throw new Error("expected invalid arguments");
  }
  expect(invalid.message).toContain("path");
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
