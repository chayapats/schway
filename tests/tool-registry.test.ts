import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { bashTool } from "../src/tools/bash.ts";
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
    bashTool,
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
  expect(registry.get("bash")?.validate({ command: "echo ok" }).ok).toBe(true);
  expect(registry.get("bash")?.validate({ command: "" }).ok).toBe(false);
  expect(
    registry.get("bash")?.validate({ command: "sleep 1", timeout: 500 }).ok,
  ).toBe(true);
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

test("plain JSON Schema validates without TypeBox symbols or argument coercion", () => {
  const registry = createToolRegistry([stub({
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
    additionalProperties: false,
  })]);
  const validate = registry.get("stub")!.validate;
  expect(validate({ name: "Ada" }).ok).toBe(true);
  expect(validate({ name: 1 }).ok).toBe(false);
  expect(validate({}).ok).toBe(false);
  expect(validate({ name: "" }).ok).toBe(false);
  expect(validate({ name: "Ada", extra: true }).ok).toBe(false);
  expect(registry.get("stub")!.validate).toBe(validate);
});

test("malformed supported schema keywords fail at registration", () => {
  for (const schema of [
    { type: "object", required: "name" },
    { type: "string", minLength: "one" },
    { type: "array", minItems: -1 },
    { type: "object", additionalProperties: "yes" },
    { type: "number", enum: [] },
  ]) {
    expect(() => createToolRegistry([stub(schema)])).toThrow("Invalid schema");
  }
});
