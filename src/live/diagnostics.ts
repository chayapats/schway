import type { SmokeScenario } from "./smoke.ts";

/** Count smoke-lane progress without retaining provider content, endpoints, headers, or credentials. */
export interface SmokeDiagnostics {
  modelAttemptsStarted: number;
  modelRoundsCompleted: number;
  toolResultsCompleted: number;
  providerRetries: number;
  httpRequestsStarted: number;
  httpResponsesReceived: number;
  lastHttpStatus?: number;
}

/** Preserve only resolved authentication category and bounded progress across a worker hard stop. */
export interface SmokeProgress {
  authSource: SmokeScenario["authSource"];
  diagnostics: SmokeDiagnostics;
}

const counters = ["modelAttemptsStarted", "modelRoundsCompleted", "toolResultsCompleted", "providerRetries",
  "httpRequestsStarted", "httpResponsesReceived"] as const;
const authSources = new Set(["runtime", "env", "stored", "stored-subscription", "none", "unavailable"]);

/** Reject malformed or content-bearing progress and return a fresh allowlisted numeric snapshot. */
export function parseSmokeDiagnostics(value: unknown): SmokeDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => ![...counters, "lastHttpStatus"].includes(key))
    || counters.some(key => !Number.isInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 1000)
    || (data.lastHttpStatus !== undefined && (!Number.isInteger(data.lastHttpStatus)
      || (data.lastHttpStatus as number) < 100 || (data.lastHttpStatus as number) > 599))
    || (data.modelRoundsCompleted as number) > (data.modelAttemptsStarted as number)
    || (data.httpResponsesReceived as number) > (data.httpRequestsStarted as number)
    || (data.httpResponsesReceived === 0 && data.lastHttpStatus !== undefined)) return;
  return { modelAttemptsStarted: data.modelAttemptsStarted as number, modelRoundsCompleted: data.modelRoundsCompleted as number,
    toolResultsCompleted: data.toolResultsCompleted as number, providerRetries: data.providerRetries as number,
    httpRequestsStarted: data.httpRequestsStarted as number, httpResponsesReceived: data.httpResponsesReceived as number,
    ...(data.lastHttpStatus !== undefined ? { lastHttpStatus: data.lastHttpStatus as number } : {}) };
}

/** Accept only the exact private checkpoint schema; a checkpoint cannot report successful verification. */
export function parseSmokeProgress(value: unknown): SmokeProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "authSource") || !Object.hasOwn(data, "diagnostics")
    || !authSources.has(data.authSource as string)) return;
  const diagnostics = parseSmokeDiagnostics(data.diagnostics);
  if (!diagnostics) return;
  return { authSource: data.authSource as SmokeScenario["authSource"], diagnostics };
}
