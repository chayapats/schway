import { defineExtension, type ExtensionEvent } from "schway/extensions";

/** Register interactive commands and count native events for this loaded runtime. */
export default defineExtension((extension) => {
  const counts = new Map<ExtensionEvent["type"], number>();
  const unsubscribe = extension.onRuntimeEvent((event, { signal }) => {
    if (!signal.aborted) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  });
  extension.onDispose(() => {
    unsubscribe();
    counts.clear();
  });

  extension.registerCommand({
    name: "event-counts",
    description: "Show native runtime event counts since startup",
    execute(args, { signal }) {
      signal.throwIfAborted();
      if (args) return "Usage: /event-counts";
      return counts.size
        ? [...counts].map(([type, count]) => `${type}: ${count}`).join("\n")
        : "No runtime events observed yet. Send a prompt first.";
    },
  });

  extension.registerCommand({
    name: "ask-extension",
    description: "Submit a prompt through the current conversation",
    arguments: "<prompt>",
    execute(args, command) {
      command.signal.throwIfAborted();
      if (!args) return "Usage: /ask-extension <prompt>";
      command.submitPrompt(args);
      return "Submitting your prompt.";
    },
  });
});
