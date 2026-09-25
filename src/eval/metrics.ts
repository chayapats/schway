import { createHmac, randomBytes } from "node:crypto";
import type { RuntimeEvent } from "../agent/events.ts";
import type { Session } from "../session/session.ts";

/** Numeric execution counters and reported token totals for one bounded run. */
export interface EvalMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  unknownInputAttempts: number;
  unknownOutputAttempts: number;
  incompleteAttempts: number;
  toolCalls: number;
  toolFailures: number;
  providerRetries: number;
  compactions: number;
  repeatedToolCalls: number;
}

/** Accumulate runtime events and completed native tool calls without persisting arguments. */
export function createEvalMetrics(session: Session): {
  record(event: RuntimeEvent): void;
  result(): EvalMetrics;
} {
  const key = randomBytes(32);
  const calls = new Map<string, number>();
  const metrics: EvalMetrics = {
    inputTokens: null, outputTokens: null, unknownInputAttempts: 0,
    unknownOutputAttempts: 0, incompleteAttempts: 0, toolCalls: 0,
    toolFailures: 0, providerRetries: 0, compactions: 0, repeatedToolCalls: 0,
  };
  return {
    record(event) {
      if (event.type === "model.usage") {
        if (event.usage.inputTokens === null) metrics.unknownInputAttempts++;
        else metrics.inputTokens = (metrics.inputTokens ?? 0) + event.usage.inputTokens;
        if (event.usage.outputTokens === null) metrics.unknownOutputAttempts++;
        else metrics.outputTokens = (metrics.outputTokens ?? 0) + event.usage.outputTokens;
        if (!event.complete) metrics.incompleteAttempts++;
      } else if (event.type === "model.retry") metrics.providerRetries++;
      else if (event.type === "compaction.finished" && event.status === "completed") metrics.compactions++;
      else if (event.type === "tool.started") metrics.toolCalls++;
      else if (event.type === "tool.finished" && event.status !== "success") metrics.toolFailures++;
      else if (event.type === "model.finished") {
        const message = session.items.at(-1);
        if (message?.type !== "assistant") return;
        for (const block of message.content) {
          if (block.type !== "tool_call") continue;
          // HMAC key is ephemeral and never written to the artifact. Equal JSON objects
          // with different property insertion order count as the same invocation.
          const digest = createHmac("sha256", key)
            .update(block.name).update("\0").update(canonical(block.arguments)).digest("hex");
          const count = calls.get(digest) ?? 0;
          if (count > 0) metrics.repeatedToolCalls++;
          calls.set(digest, count + 1);
        }
      }
    },
    result: () => ({ ...metrics }),
  };
}

/** Stable serialization of JSON-like tool arguments, independent of object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
