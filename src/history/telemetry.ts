import type { RuntimeEvent } from "../agent/events.ts";
import type { ModelUsage } from "../model/model.ts";
import type { HistoryTelemetry, HistoryTokenTotal } from "./records.ts";

/** Incremental fold of one attempt's model and tool timing events into sidecar telemetry. */
export interface HistoryTelemetryFold {
  /** Fold one runtime event; events other than turn `model.usage`, `model.retry`, `model.started` and `tool.finished` are ignored. */
  observe(event: RuntimeEvent): void;
  /** Current totals; tool time is the union of measured call intervals, so parallel calls count once. */
  summary(): HistoryTelemetry;
}

/** Token dimensions folded from `ModelUsage`, keyed by their sidecar names. */
const DIMENSIONS = [["input", "inputTokens"], ["cachedInput", "cachedInputTokens"], ["output", "outputTokens"], ["reasoning", "reasoningTokens"]] as const;

/** Create an empty fold; it never measures time itself and records only what events report. */
export function createHistoryTelemetryFold(): HistoryTelemetryFold {
  const telemetry = emptyHistoryTelemetry();
  const intervals: Array<[number, number]> = [];
  let pendingRetryWaitMs = 0;
  return {
    observe(event) {
      if (event.type === "model.retry") { telemetry.retries++; pendingRetryWaitMs = event.delayMs; return; }
      // A retry's backoff counts once the next attempt actually starts.
      if (event.type === "model.started") { telemetry.retryWaitMs += pendingRetryWaitMs; pendingRetryWaitMs = 0; return; }
      if (event.type === "model.usage" && event.phase === "turn") {
        telemetry.modelCalls++;
        if (isMs(event.attemptMs)) telemetry.modelMs += event.attemptMs;
        if (isMs(event.firstDeltaMs)) {
          const first = telemetry.firstDelta;
          telemetry.firstDelta = first ? { minMs: Math.min(first.minMs, event.firstDeltaMs), maxMs: Math.max(first.maxMs, event.firstDeltaMs), calls: first.calls + 1 }
            : { minMs: event.firstDeltaMs, maxMs: event.firstDeltaMs, calls: 1 };
        }
        foldUsage(telemetry, event.usage);
        return;
      }
      if (event.type !== "tool.finished" || !isMs(event.durationMs)) return;
      const start = typeof event.startedAt === "string" ? Date.parse(event.startedAt) : NaN;
      if (!Number.isFinite(start)) return;
      telemetry.toolCalls++;
      intervals.push([start, start + event.durationMs]);
      if (isMs(event.approvalWaitMs)) telemetry.approvalWaitMs += Math.min(event.approvalWaitMs, event.durationMs);
    },
    summary() {
      return { ...telemetry, toolMs: unionMs(intervals), tokens: copyTokens(telemetry.tokens), ...(telemetry.firstDelta ? { firstDelta: { ...telemetry.firstDelta } } : {}) };
    },
  };
}

/** Combine sequential attempts of one turn; every total adds, and the first-output range spans all attempts. */
export function combineHistoryTelemetry(parts: readonly HistoryTelemetry[]): HistoryTelemetry {
  const combined = emptyHistoryTelemetry();
  for (const part of parts) {
    combined.modelCalls += part.modelCalls; combined.modelMs += part.modelMs; combined.retries += part.retries; combined.retryWaitMs += part.retryWaitMs;
    combined.toolCalls += part.toolCalls; combined.toolMs += part.toolMs; combined.approvalWaitMs += part.approvalWaitMs;
    if (part.firstDelta) {
      const first = combined.firstDelta;
      combined.firstDelta = first ? { minMs: Math.min(first.minMs, part.firstDelta.minMs), maxMs: Math.max(first.maxMs, part.firstDelta.maxMs), calls: first.calls + part.firstDelta.calls }
        : { ...part.firstDelta };
    }
    for (const [name] of DIMENSIONS) {
      combined.tokens[name].total += part.tokens[name].total;
      combined.tokens[name].reportedCalls += part.tokens[name].reportedCalls;
    }
  }
  return combined;
}

/** Telemetry with no observed calls. */
function emptyHistoryTelemetry(): HistoryTelemetry {
  const total = (): HistoryTokenTotal => ({ total: 0, reportedCalls: 0 });
  return { modelCalls: 0, modelMs: 0, firstDelta: null, retries: 0, retryWaitMs: 0, toolCalls: 0, toolMs: 0, approvalWaitMs: 0,
    tokens: { input: total(), cachedInput: total(), output: total(), reasoning: total() } };
}

/** Add each reported dimension; an unreported (null or absent) dimension adds neither tokens nor coverage. */
function foldUsage(telemetry: HistoryTelemetry, usage: ModelUsage): void {
  for (const [name, field] of DIMENSIONS) {
    const value = usage[field];
    if (!isMs(value)) continue;
    telemetry.tokens[name].total += value;
    telemetry.tokens[name].reportedCalls++;
  }
}

function copyTokens(tokens: HistoryTelemetry["tokens"]): HistoryTelemetry["tokens"] {
  return { input: { ...tokens.input }, cachedInput: { ...tokens.cachedInput }, output: { ...tokens.output }, reasoning: { ...tokens.reasoning } };
}

/** Total length covered by at least one interval. */
function unionMs(intervals: readonly (readonly [number, number])[]): number {
  let total = 0, end = -Infinity;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop <= end) continue;
    total += stop - Math.max(start, end);
    end = stop;
  }
  return Math.round(total);
}

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
