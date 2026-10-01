import { compileValidator, type SchemaValidator } from "./schema.ts";
import { toolEffect, type ToolDefinition } from "./types.ts";

/** A registered tool plus the validator compiled at registration. */
export interface RegisteredTool {
  definition: ToolDefinition;
  validate: SchemaValidator;
}

/** Name-indexed set of tools available to the agent loop. */
export interface ToolRegistry {
  /** Validate the effect and compile the schema, rejecting duplicate names or invalid declarations. */
  register(definition: ToolDefinition): void;
  /** Return the registered definition and validator, or undefined for an unknown name. */
  get(name: string): RegisteredTool | undefined;
  /** Return definitions in registration order, including their execute functions. */
  definitions(): readonly ToolDefinition[];
}

/** Create a registry seeded in order, rejecting duplicate names, invalid effects or unsupported schemas. */
export function createToolRegistry(
  definitions: readonly ToolDefinition[] = [],
): ToolRegistry {
  const registry = registryFromEntries(new Map());
  for (const definition of definitions) {
    registry.register(definition);
  }
  return registry;
}

/** Copy a registry's compiled entries so new registrations cannot partially mutate the original. */
export function forkToolRegistry(source: ToolRegistry): ToolRegistry {
  return registryFromEntries(new Map(source.definitions().map((definition) => [
    definition.name, source.get(definition.name)!,
  ])));
}

/** Wrap privately owned entries in the standard registry interface. */
function registryFromEntries(tools: Map<string, RegisteredTool>): ToolRegistry {

  const registry: ToolRegistry = {
    /** Compile the input schema and store the tool. Duplicate names throw. */
    register(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`Tool already registered: ${definition.name}`);
      }
      if (!["read-only", "mutating"].includes(toolEffect(definition))) {
        throw new Error(`Invalid effect for tool "${definition.name}": expected read-only or mutating`);
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

  return registry;
}
