import { defineExtension } from "schway/extensions";

/** Register the greeting tool when this installed package is explicitly enabled. */
export default defineExtension(({ registerTool }) => {
  registerTool<{ name: string }>({
    name: "greet",
    description: "Greet someone by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
    execution: "parallel",
    async execute({ name }, context) {
      context.signal?.throwIfAborted();
      return { content: `Hello, ${name}!` };
    },
  });
});
