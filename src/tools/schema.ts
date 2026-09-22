import Ajv from "ajv";

const validatorCompiler = new Ajv({ strict: false, strictNumbers: true, allErrors: true });

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

/** Validate tool arguments without coercion, returning the original value or a diagnostic message. */
export type SchemaValidator = (
  value: unknown,
) => { ok: true; value: unknown } | { ok: false; message: string };

/** JSON-round-trip a schema to remove TypeBox symbols, throwing on serialization failure or a non-object result. */
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
    // The explicit subset guard handles unknown keywords; Ajv validates keyword
    // shapes and compiles plain JSON without requiring TypeBox's private symbols.
    compiled = validatorCompiler.compile(plain);
    // Keep compiled closures on registries without retaining every schema in the
    // process-wide compiler's cache; its shared meta-schema stays compiled.
    validatorCompiler.removeSchema(plain);
  } catch (error) {
    throw new Error(
      `Unable to compile tool schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return (value: unknown) => {
    if (compiled(value)) {
      return { ok: true, value };
    }
    const errors = (compiled.errors ?? [])
      .map((entry) => `${entry.instancePath || "/"} ${entry.message}`.trim())
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
