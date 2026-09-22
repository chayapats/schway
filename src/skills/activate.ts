import { Type } from "@sinclair/typebox";
import type { ContextManager } from "../context/manager.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { SKILL_NAME_MAX_LENGTH } from "./skills.ts";

/** Bind the exclusive native activation tool to the current turn's context manager. */
export function createActivateSkillTool(manager: ContextManager): ToolDefinition<{ name: string }> {
  return {
    name: "activate_skill",
    description: "Activate an available skill for this user turn, replacing any active skill. User-only skills cannot be activated by the model.",
    inputSchema: Type.Object({
      name: Type.String({ minLength: 1, maxLength: SKILL_NAME_MAX_LENGTH }),
    }, { additionalProperties: false }),
    execution: "exclusive",
    async execute({ name }, { signal }) {
      try {
        const result = await manager.activateSkill(name, { signal });
        if (!result.ok) {
          return { content: result.error.slice(0, 1_000), isError: true };
        }
        return { content: `Activated skill '${name}' for this user turn.` };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        return { content: "Skill activation failed; rediscover skills and retry.", isError: true };
      }
    },
  };
}
