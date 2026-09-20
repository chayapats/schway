import { compileValidator, type SchemaValidator } from "./schema.ts";
import type { ToolDefinition } from "./types.ts";

export interface RegisteredTool {
  definition: ToolDefinition;
  validate: SchemaValidator;
}

export interface ToolRegistry {
  register(definition: ToolDefinition): void;
  get(name: string): RegisteredTool | undefined;
  definitions(): readonly ToolDefinition[];
}

export function createToolRegistry(
  definitions: readonly ToolDefinition[] = [],
): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  const registry: ToolRegistry = {
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
    get(name) {
      return tools.get(name);
    },
    definitions() {
      return [...tools.values()].map((entry) => entry.definition);
    },
  };

  for (const definition of definitions) {
    registry.register(definition);
  }
  return registry;
}
