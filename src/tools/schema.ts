import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf",
  "nullable",
]);

const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** Compiled check for model-generated tool arguments. */
export type SchemaValidator = (
  value: unknown,
) => { ok: true; value: unknown } | { ok: false; message: string };

/** Clone a TypeBox or JSON Schema value into a plain JSON object. */
export function toPlainJsonSchema(schema: unknown): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(schema)) as unknown;
  if (typeof plain !== "object" || plain === null || Array.isArray(plain)) {
    throw new Error("Tool input schema must be a JSON Schema object");
  }
  return plain as Record<string, unknown>;
}

/**
 * Reject JSON Schema constructs outside the subset Schway tools support.
 * Throws an actionable error naming the keyword and path.
 */
export function assertSupportedJsonSchema(schema: unknown, path = ""): void {
  if (schema === true || schema === false) {
    return;
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(
      `Unsupported JSON Schema at ${formatPath(path)}: expected an object`,
    );
  }

  const object = schema as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key === "$schema" || key.startsWith("x-")) {
      continue;
    }
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(
        `Unsupported JSON Schema keyword "${key}" at ${formatPath(path)}`,
      );
    }
  }

  if (object.type !== undefined) {
    const types = Array.isArray(object.type) ? object.type : [object.type];
    for (const type of types) {
      if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
        throw new Error(
          `Unsupported JSON Schema type ${JSON.stringify(type)} at ${formatPath(path)}`,
        );
      }
    }
  }

  if (object.properties !== undefined) {
    if (
      typeof object.properties !== "object" ||
      object.properties === null ||
      Array.isArray(object.properties)
    ) {
      throw new Error(
        `Unsupported JSON Schema at ${formatPath(path)}: properties must be an object`,
      );
    }
    for (const [name, nested] of Object.entries(
      object.properties as Record<string, unknown>,
    )) {
      assertSupportedJsonSchema(nested, `${path}/properties/${name}`);
    }
  }

  if (object.items !== undefined) {
    if (Array.isArray(object.items)) {
      object.items.forEach((item, index) => {
        assertSupportedJsonSchema(item, `${path}/items/${index}`);
      });
    } else {
      assertSupportedJsonSchema(object.items, `${path}/items`);
    }
  }

  if (object.additionalProperties !== undefined) {
    assertSupportedJsonSchema(
      object.additionalProperties,
      `${path}/additionalProperties`,
    );
  }

  if (object.anyOf !== undefined) {
    assertSchemaArray(object.anyOf, `${path}/anyOf`);
  }
  if (object.oneOf !== undefined) {
    assertSchemaArray(object.oneOf, `${path}/oneOf`);
  }
}

/**
 * Compile a validator once at tool registration.
 * Unsupported schemas fail here rather than at invocation time.
 */
export function compileValidator(schema: unknown): SchemaValidator {
  const plain = toPlainJsonSchema(schema);
  assertSupportedJsonSchema(plain);
  let compiled;
  try {
    compiled = TypeCompiler.Compile(schema as TSchema);
  } catch (error) {
    throw new Error(
      `Unable to compile tool schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return (value: unknown) => {
    if (compiled.Check(value)) {
      return { ok: true, value };
    }
    const errors = [...compiled.Errors(value)]
      .map((entry) => `${entry.path || "/"} ${entry.message}`.trim())
      .join("; ");
    return { ok: false, message: errors || "Invalid arguments" };
  };
}

/** Require a non-empty array of nested schemas, then walk each entry. */
function assertSchemaArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Unsupported JSON Schema at ${formatPath(path)}: expected a non-empty array`,
    );
  }
  value.forEach((entry, index) => {
    assertSupportedJsonSchema(entry, `${path}/${index}`);
  });
}

/** JSON-pointer-like path used in schema error messages. */
function formatPath(path: string): string {
  return path.length === 0 ? "/" : path;
}
