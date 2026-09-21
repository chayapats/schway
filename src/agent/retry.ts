import type { AssistantMessage } from "../conversation/types.ts";
import type { Model, ModelRequest } from "../model/model.ts";
import type { RuntimeEvent } from "./events.ts";

/** Total provider stream attempts allowed for one model turn, including the first. */
const MAX_TRANSIENT_ATTEMPTS = 3;

/** Backoff before the second attempt when the provider does not send Retry-After. */
const DEFAULT_BACKOFF_MS = 1000;

/** Upper bound for one backoff, so a provider hint cannot stall the run. */
const MAX_BACKOFF_MS = 30_000;

/** Injected time source so retry tests can control backoff without waiting. */
export interface AgentClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Outcome of streaming one model turn, after retries and cancellation. */
export type ModelTurnOutcome =
  | { kind: "complete"; message: AssistantMessage }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

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

/** Real-time clock used by production runs. */
export function systemClock(): AgentClock {
  return {
    now: () => Date.now(),
    sleep: abortableSleep,
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

/** Stream one model turn with bounded transport retries; the caller persists a complete message. */
export async function* streamModelTurn(options: {
  model: Model;
  request: ModelRequest;
  clock: AgentClock;
  signal?: AbortSignal;
}): AsyncGenerator<RuntimeEvent, ModelTurnOutcome> {
  const { model, request, clock, signal } = options;

  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }

    yield {
      type: "model.started",
      provider: model.provider,
      model: model.id,
    };

    let complete: AssistantMessage | undefined;
    try {
      for await (const event of model.stream(request)) {
        if (event.type === "text_delta") {
          yield {
            type: "model.delta",
            content: { type: "text", text: event.text },
          };
        } else if (event.type === "thinking_delta") {
          yield {
            type: "model.delta",
            content: { type: "thinking", text: event.text },
          };
        } else {
          complete = event.message;
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return { kind: "cancelled" };
      }
      const message = errorMessage(error);
      const transient = isTransientProviderFailure(error);
      if (transient && attempt < MAX_TRANSIENT_ATTEMPTS) {
        const delayMs = retryDelayMs(error, attempt, clock.now());
        yield {
          type: "model.retry",
          attempt,
          maxAttempts: MAX_TRANSIENT_ATTEMPTS,
          delayMs,
          message,
        };
        try {
          await clock.sleep(delayMs, signal);
        } catch (sleepError) {
          if (signal?.aborted || isAbortError(sleepError)) {
            return { kind: "cancelled" };
          }
          return { kind: "error", message: errorMessage(sleepError) };
        }
        continue;
      }
      if (transient) {
        return {
          kind: "error",
          message: `Provider request failed after ${MAX_TRANSIENT_ATTEMPTS} transient attempts: ${message}`,
        };
      }
      return { kind: "error", message };
    }

    if (!complete) {
      return {
        kind: "error",
        message: "Model stream ended without a complete message",
      };
    }
    return { kind: "complete", message: complete };
  }

  return {
    kind: "error",
    message: `Provider request failed after ${MAX_TRANSIENT_ATTEMPTS} transient attempts`,
  };
}

/** True for rate limits, 5xx, and transient network failures; false for abort/4xx. */
function isTransientProviderFailure(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  let sawNetwork = false;
  for (const item of errorChain(error)) {
    if (isAbortError(item)) {
      return false;
    }
    const status = httpStatus(item);
    if (status === 429) {
      return true;
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      return true;
    }
    if (status !== undefined && status >= 400 && status <= 499) {
      return false;
    }
    if (isNetworkFailure(item)) {
      sawNetwork = true;
    }
  }
  return sawNetwork;
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
