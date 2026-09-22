import { redactSecrets } from "../auth/secrets.ts";
import type { ToolContext, ToolDefinition, ToolOutputChunk } from "../tools/types.ts";

const OUTPUT_LIMIT = 50_000;
const TRUNCATION = "\n[Extension output truncated at 50000 characters; narrow the request or add pagination.]";

/** Bound extension text and normalize runtime values before they enter native execution. */
export function guardExtensionTool(tool: ToolDefinition, identity: string, secrets: readonly string[]): ToolDefinition {
  return Object.freeze({
    ...tool,
    async execute(input: unknown, ctx: ToolContext) {
      const outputSink = guardedOutput(ctx.onOutput, secrets);
      try {
        let output;
        try {
          output = await tool.execute(input, {
            ...ctx,
            workspace: { ...ctx.workspace, extraRoots: [...ctx.workspace.extraRoots] },
            onOutput: ctx.onOutput ? outputSink.write : undefined,
          });
        } finally {
          outputSink.close();
        }
        if (!output || typeof output.content !== "string" ||
          (output.isError !== undefined && typeof output.isError !== "boolean")) {
          throw new Error("Extension tool result requires a content string and optional isError boolean");
        }
        return {
          content: bound(redactSecrets(output.content, secrets)),
          ...(output.isError !== undefined ? { isError: output.isError } : {}),
          ...(output.details !== undefined ? { details: safeDetails(output.details, secrets) } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = new Error(bound(redactSecrets(`Extension "${identity}" tool "${tool.name}": ${message}`, secrets)));
        if (error instanceof Error && error.name === "AbortError") failure.name = "AbortError";
        throw failure;
      }
    },
  });
}

/** Retain possible credential prefixes across chunks, then flush and seal a bounded stream when execution settles. */
function guardedOutput(onOutput: ToolContext["onOutput"], secrets: readonly string[]) {
  const pending = { stdout: "", stderr: "" };
  let remaining = OUTPUT_LIMIT;
  let open = true;
  const emit = (stream: ToolOutputChunk["stream"], value: string): void => {
    const text = value.slice(0, remaining);
    remaining -= text.length;
    if (text) onOutput?.({ stream, text });
  };
  return {
    write(chunk: ToolOutputChunk): void {
      if (!open) return;
      if (!chunk || (chunk.stream !== "stdout" && chunk.stream !== "stderr") || typeof chunk.text !== "string") {
        throw new Error("Extension output requires a stdout/stderr stream and text string");
      }
      const text = redactSecrets(pending[chunk.stream] + chunk.text, secrets);
      let held = 0;
      for (const secret of secrets) {
        for (let length = Math.min(secret.length - 1, text.length); length > held; length--) {
          if (text.endsWith(secret.slice(0, length))) {
            held = length;
            break;
          }
        }
      }
      pending[chunk.stream] = text.slice(text.length - held);
      emit(chunk.stream, text.slice(0, text.length - held));
    },
    close(): void {
      open = false;
      for (const stream of ["stdout", "stderr"] as const) {
        emit(stream, redactSecrets(pending[stream], secrets));
      }
    },
  };
}

/** Include truncation guidance within the model-facing character budget. */
function bound(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : text.slice(0, OUTPUT_LIMIT - TRUNCATION.length) + TRUNCATION;
}

/** Require JSON-serializable event details and mask credentials before exposing them to subscribers. */
function safeDetails(value: unknown, secrets: readonly string[]): unknown {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  const redact = (nested: unknown): unknown => {
    if (typeof nested === "string") return redactSecrets(nested, secrets);
    if (Array.isArray(nested)) return nested.map(redact);
    if (nested && typeof nested === "object") {
      return Object.fromEntries(Object.entries(nested).map(([key, entry]) => [redactSecrets(key, secrets), redact(entry)]));
    }
    return nested;
  };
  return redact(plain);
}
