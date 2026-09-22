import { defineExtension } from "schway/extensions";

/** Register a sample policy that denies shell commands, normalizes edit paths, and annotates settled results. */
export default defineExtension((extension) => {
  extension.beforeTool(({ name, arguments: args, signal }) => {
    signal.throwIfAborted();
    if (name === "bash") return { deny: "This example policy disables shell commands. Use file tools instead." };
    // Native validation has already checked edit's input; the replacement is validated again.
    if (name === "edit" && args && typeof args === "object" && "path" in args &&
      typeof args.path === "string" && args.path.startsWith("./")) {
      return { arguments: { ...args, path: args.path.slice(2) } };
    }
  });

  extension.afterTool(({ name, outcome, signal }) => {
    signal.throwIfAborted();
    return {
      content: `${outcome.content}\n[Tool policy reviewed ${name}.]`,
      isError: outcome.isError,
      details: outcome.details,
    };
  });
});
