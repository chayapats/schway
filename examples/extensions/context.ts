import { defineExtension } from "schway/extensions";

/** Add ephemeral task and verification guidance through native request hooks. */
export default defineExtension((extension) => {
  extension.registerPrompt({
    name: "review-style",
    content: "Explain changed behavior, observed checks, and remaining limits concisely.",
  });

  extension.beforeAgent(({ message, context, signal }) => {
    signal.throwIfAborted();
    const task = message.content.map(block => block.text).join("\n");
    return { context: [...context, { name: "current-task", content: task }] };
  });

  extension.context(({ context, signal }) => {
    signal.throwIfAborted();
    return [...context, { name: "verification", content: "Use relevant deterministic checks before reporting success." }];
  });

  extension.beforeModel((request) => {
    request.signal.throwIfAborted();
    return { ...request, systemPrompt: `${request.systemPrompt}\n\nDistinguish observed results from assumptions.` };
  });
});
