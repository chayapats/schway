import { defineExtension, type ToolDefinition } from "schway/extensions";

const greet: ToolDefinition<{ name: string }> = {
  name: "greet",
  description: "Greet someone by name.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
    additionalProperties: false,
  },
  effect: "read-only",
  execution: "parallel",
  async execute({ name }, ctx) {
    ctx.signal?.throwIfAborted();
    ctx.onOutput?.({ stream: "stdout", text: "Preparing greeting…\n" });
    return { content: `Hello, ${name}!` };
  },
};

/** Register the greeting tool during explicitly enabled startup. */
export default defineExtension(({ registerTool }) => {
  registerTool(greet);
});
