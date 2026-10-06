import type { AssistantMessage, AssistantTelemetry } from "../conversation/types.ts";
import type { Model, ModelCallOptions, ModelRequest, ModelUsage } from "../model/model.ts";
import type { ModelRetryCause, RuntimeEvent } from "./events.ts";

/** Total provider stream attempts allowed for one model turn, including the first. */
const MAX_TRANSIENT_ATTEMPTS = 3;

/** Backoff before the second attempt when the provider does not send Retry-After. */
const DEFAULT_BACKOFF_MS = 1000;

/** Upper bound for one backoff, so a provider hint cannot stall the run. */
const MAX_BACKOFF_MS = 30_000;

/** Injected time source so retry tests can control backoff without waiting. */
export interface AgentClock {
  /** Return milliseconds since the Unix epoch for interpreting provider retry timestamps. */
  now(): number;
  /** Wait for the requested milliseconds, rejecting when the supplied signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Return monotonic milliseconds for measuring durations; `now` is used when absent. */
  monotonicNow?(): number;
}

/** Monotonic milliseconds from `clock`, falling back to its wall clock when it has no monotonic source. */
export function monotonicNow(clock: AgentClock): number {
  return clock.monotonicNow ? clock.monotonicNow() : clock.now();
}

/** Whole nonnegative milliseconds between two monotonic readings. */
export function elapsedMs(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

/** Outcome of streaming one model turn, after retries and cancellation. */
export type ModelTurnOutcome =
  | { kind: "complete"; message: AssistantMessage }
  | { kind: "cancelled" }
  | { kind: "overflow"; message: string }
  | { kind: "error"; message: string; category?: "auth" | "credential-store" | "model" | "offline" | "rate-limit" | "provider" };

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_NAMES = new Set([
  "APIConnectionError",
  "FetchError",
  "TimeoutError",
  "ConnectTimeoutError",
]);

const NETWORK_MESSAGE =
  /connection (reset|error|refused|aborted|closed)|network reset|network error|socket hang up|fetch failed|econnreset|etimedout|enotfound|temporarily unavailable/i;

/** Return a wall clock, a monotonic clock and abortable timer sleeps that reject with an AbortError. */
export function systemClock(): AgentClock {
  return {
    now: () => Date.now(),
    sleep: abortableSleep,
    monotonicNow: () => performance.now(),
  };
}

/** Sleep that resolves on timeout or rejects as soon as `signal` aborts. */
async function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw abortError();
    }
    return;
  }
  if (signal?.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stream turn events with bounded transport retries and return completion, cancellation, overflow, or error.
 * Partial deltas may be emitted again after a retry; only the caller persists a complete message.
 * Every attempt reports its timing on `model.usage`, and a complete message carries harness telemetry measured with `clock`.
 */
export async function* streamModelTurn(options: {
  model: Model;
  request: ModelRequest;
  /** Schway-owned call settings, sent unchanged with every attempt including transport retries. */
  call?: ModelCallOptions;
  clock: AgentClock;
  signal?: AbortSignal;
}): AsyncGenerator<RuntimeEvent, ModelTurnOutcome> {
  const { model, request, call, clock, signal } = options;
  const firstStart = monotonicNow(clock);
  const startedAt = new Date(clock.now()).toISOString();
  let retryWaitMs = 0;

  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }

    yield {
      type: "model.started",
      provider: model.provider,
      model: model.id,
    };

    const attemptStart = monotonicNow(clock);
    const attemptStartedAt = attempt === 1 ? startedAt : new Date(clock.now()).toISOString();
    let firstDeltaMs: number | null = null;
    let attemptMs: number | undefined;
    let attemptWaitMs: number | undefined;
    let complete: AssistantMessage | undefined;
    let usage: ModelUsage = { inputTokens: null, outputTokens: null };
    let failed = false;
    try {
      for await (const event of model.stream(request, call)) {
        if (event.type === "text_delta" || event.type === "thinking_delta") {
          firstDeltaMs ??= elapsedMs(attemptStart, monotonicNow(clock));
          yield {
            type: "model.delta",
            content: { type: event.type === "text_delta" ? "text" : "thinking", text: event.text },
          };
        } else if (event.type === "usage") {
          // Terminal totals supersede earlier partial reports from the same attempt.
          usage = event.usage;
        } else {
          complete = event.message;
        }
      }
      attemptMs = elapsedMs(attemptStart, monotonicNow(clock));
    } catch (error) {
      attemptMs = elapsedMs(attemptStart, monotonicNow(clock));
      failed = true;
      if (signal?.aborted || isAbortError(error)) {
        return { kind: "cancelled" };
      }
      const message = errorMessage(error);
      if (isContextOverflowError(error)) {
        return { kind: "overflow", message };
      }
      const cause = transientFailureCause(error);
      const transient = cause !== undefined;
      if (transient && attempt < MAX_TRANSIENT_ATTEMPTS) {
        const delayMs = retryDelayMs(error, attempt, clock.now());
        yield {
          type: "model.retry",
          attempt,
          maxAttempts: MAX_TRANSIENT_ATTEMPTS,
          delayMs,
          message,
          cause,
        };
        const waitStart = monotonicNow(clock);
        try {
          await clock.sleep(delayMs, signal);
        } catch (sleepError) {
          if (signal?.aborted || isAbortError(sleepError)) {
            return { kind: "cancelled" };
          }
          return { kind: "error", message: errorMessage(sleepError), category: "offline" };
        } finally {
          // Time actually waited, even when cancellation or a failed timer ends the backoff early.
          attemptWaitMs = elapsedMs(waitStart, monotonicNow(clock));
          retryWaitMs += attemptWaitMs;
        }
        continue;
      }
      if (transient) {
        return {
          kind: "error",
          message: `Provider request failed after ${MAX_TRANSIENT_ATTEMPTS} transient attempts: ${message}`,
          category: providerFailureCategory(error),
        };
      }
      return { kind: "error", message, category: providerFailureCategory(error) };
    } finally {
      // A consumer that stops early still observes this attempt's elapsed time.
      attemptMs ??= elapsedMs(attemptStart, monotonicNow(clock));
      yield { type: "model.usage", phase: "turn", usage, complete: !!complete && !failed && !signal?.aborted,
        startedAt: attemptStartedAt, firstDeltaMs, attemptMs, ...(attemptWaitMs !== undefined ? { retryWaitMs: attemptWaitMs } : {}) };
    }

    if (!complete) {
      return {
        kind: "error",
        message: "Model stream ended without a complete message",
      };
    }
    const telemetry: AssistantTelemetry = {
      startedAt,
      firstDeltaMs,
      attemptMs: attemptMs ?? 0,
      totalMs: elapsedMs(firstStart, monotonicNow(clock)),
      attempts: attempt,
      retryWaitMs,
      usage: { ...usage },
    };
    return { kind: "complete", message: { ...complete, telemetry } };
  }

  return {
    kind: "error",
    message: `Provider request failed after ${MAX_TRANSIENT_ATTEMPTS} transient attempts`,
  };
}

/** Classify a provider failure from structured status before its diagnostic text is displayed. */
function providerFailureCategory(error: unknown): "auth" | "credential-store" | "model" | "offline" | "rate-limit" | "provider" {
  for (const item of errorChain(error)) {
    const status = httpStatus(item);
    const message = item instanceof Error ? item.message : String(item ?? "");
    if (/Cannot (read|save|delete) credential in the OS secure store|secure store|Secret Service|libsecret/i.test(message)) return "credential-store";
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate-limit";
    const code = overflowField(item, ["code", "type"]);
    if ((status === 400 || status === 404 || status === 422) &&
      (/(unknown|unavailable|not found|does not exist|invalid)\s+model|model\s+(not found|unavailable|does not exist|invalid)/i.test(message) ||
        code && /model_(not_found|unavailable|invalid)/i.test(code))) return "model";
    if (isNetworkFailure(item)) return "offline";
  }
  return "provider";
}

/**
 * Retry cause for rate limits, 5xx, and transient network failures; undefined for abort/4xx.
 * The first HTTP status in the error chain decides; a network failure counts only when no status does.
 */
function transientFailureCause(error: unknown): ModelRetryCause | undefined {
  if (isAbortError(error)) {
    return undefined;
  }
  let sawNetwork = false;
  for (const item of errorChain(error)) {
    if (isAbortError(item)) {
      return undefined;
    }
    const status = httpStatus(item);
    if (status === 429) {
      return "rate-limit";
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      return "provider";
    }
    if (status !== undefined && status >= 400 && status <= 499) {
      return undefined;
    }
    if (isNetworkFailure(item)) {
      sawNetwork = true;
    }
  }
  return sawNetwork ? "offline" : undefined;
}

/** Distinct provider context-overflow signal; never treated as a transient retry. */
const OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context-length-exceeded",
  "context_too_long",
  "input_too_long",
  "prompt_too_long",
  "too_many_tokens",
]);

const OVERFLOW_MESSAGE =
  /context\s*(length|window|size)?\s*(exceeded|too\s*(long|large|big))|maximum\s*context|(input|prompt|request|message)\s*(is\s+)?too\s*(long|large|big)|too\s*many\s*tokens|tokens\s*>\s*\d+\s*maximum|context_length_exceeded/i;

/** Recognize provider context-overflow codes or message patterns, excluding aborts and rate-limit entries. */
export function isContextOverflowError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  for (const item of errorChain(error)) {
    if (isAbortError(item)) {
      return false;
    }
    // Rate limits stay transient even if their message mentions tokens.
    if (httpStatus(item) === 429) {
      continue;
    }
    const code = overflowField(item, ["code", "type"]);
    if (code && OVERFLOW_CODES.has(code.toLowerCase())) {
      return true;
    }
    const message =
      item instanceof Error ? item.message : String(item ?? "");
    if (OVERFLOW_MESSAGE.test(message)) {
      const status = httpStatus(item);
      // Explicit overflow codes/messages win even without status; otherwise
      // require a client error status so 5xx overloads stay transient.
      if (status === undefined || (status >= 400 && status < 500)) {
        return true;
      }
    }
  }
  return false;
}

/** Read a lowercase string field such as `code` or `type` from an error. */
function overflowField(item: unknown, names: string[]): string | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const cause = (record as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    for (const name of names) {
      const value = (cause as Record<string, unknown>)[name];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/** Backoff for the failed attempt: Retry-After when present, otherwise exponential. */
function retryDelayMs(
  error: unknown,
  failedAttempt: number,
  now: number,
): number {
  const hinted = retryAfterMs(error, now);
  if (hinted !== undefined) {
    return Math.min(hinted, MAX_BACKOFF_MS);
  }
  const exp = Math.max(0, failedAttempt - 1);
  return DEFAULT_BACKOFF_MS * 2 ** exp;
}

/** True for AbortError / ABORT_ERR from streams, fetch, or AbortSignal. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Normalize thrown values into a printable error string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function retryAfterMs(error: unknown, now: number): number | undefined {
  for (const item of errorChain(error)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const raw = headerValue((item as { headers?: unknown }).headers, "retry-after");
    if (raw === undefined) {
      continue;
    }
    const parsed = parseRetryAfter(raw, now);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseRetryAfter(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return undefined;
    }
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current != null; i++) {
    chain.push(current);
    if (typeof current !== "object" || !("cause" in current)) {
      break;
    }
    current = (current as { cause: unknown }).cause;
  }
  return chain;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  if (typeof record.status === "number" && Number.isFinite(record.status)) {
    return record.status;
  }
  if (typeof record.statusCode === "number" && Number.isFinite(record.statusCode)) {
    return record.statusCode;
  }
  if (
    typeof record.response?.status === "number" &&
    Number.isFinite(record.response.status)
  ) {
    return record.response.status;
  }
  return undefined;
}

function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return NETWORK_MESSAGE.test(String(error));
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return true;
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name !== undefined && NETWORK_NAMES.has(name)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return NETWORK_MESSAGE.test(message);
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers == null || typeof headers !== "object") {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      const value = (headers as Headers).get(name);
      if (value != null && value.length > 0) {
        return value;
      }
    } catch {
      // Not a Headers implementation; fall through to plain object lookup.
    }
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
      return value[0];
    }
  }
  return undefined;
}
