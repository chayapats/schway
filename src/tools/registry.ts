import { compileValidator, type SchemaValidator } from "./schema.ts";
import type { ToolDefinition } from "./types.ts";

/** A registered tool plus the validator compiled at registration. */
export interface RegisteredTool {
  definition: ToolDefinition;
  validate: SchemaValidator;
}

/** Name-indexed set of tools available to the agent loop. */
export interface ToolRegistry {
  /** Compile and store a tool's schema, throwing for duplicate names or unsupported schemas. */
  register(definition: ToolDefinition): void;
  /** Return the registered definition and validator, or undefined for an unknown name. */
  get(name: string): RegisteredTool | undefined;
  /** Return definitions in registration order, including their execute functions. */
  definitions(): readonly ToolDefinition[];
}

/** Create a registry seeded in order, throwing if an initial tool has a duplicate name or invalid schema. */
export function createToolRegistry(
  definitions: readonly ToolDefinition[] = [],
): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  const registry: ToolRegistry = {
    /** Compile the input schema and store the tool. Duplicate names throw. */
    register(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`Tool already registered: ${definition.name}`);
      }
      try {
        const validate = compileValidator(definition.inputSchema);
        tools.set(definition.name, { definition, validate });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid schema for tool "${definition.name}": ${detail}`,
        );
      }
    },
    /** Look up a compiled tool by name. */
    get(name) {
      return tools.get(name);
    },
    /** Definitions in registration order, including execute functions. */
    definitions() {
      return [...tools.values()].map((entry) => entry.definition);
    },
  };

  for (const definition of definitions) {
    registry.register(definition);
  }
  return registry;
}
