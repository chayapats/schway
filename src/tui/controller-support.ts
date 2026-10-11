import { redactSecrets } from "../auth/secrets.ts";
import { CHATGPT_ROUTE, canonicalOpenAIAuth } from "../auth/chatgpt-route.ts";
import type { TuiRecovery } from "./controller-types.ts";
import { sanitizeBaseUrl } from "./transcript-format.ts";

/** Plain-language recovery guidance never includes provider diagnostic text. */
export function recoveryMessage(category: TuiRecovery["category"]): string {
  switch (category) {
    case "auth": return "Access rejected · Connect again to continue";
    case "credential-store": return "Credential storage unavailable · Unlock the secure store";
    case "model": return "Model unavailable · Choose another model";
    case "offline": return "Connection unavailable · Check your network";
    case "rate-limit": return "Usage limit reached · Wait before continuing";
    case "session-write": return "Progress not saved · Repair storage before continuing";
    default: return "Request failed · Inspect details before continuing";
  }
}

/** Every turn recovery category, each reachable from a runtime error the agent loop emits. */
export const RECOVERY_CATEGORIES = Object.keys({ auth: 1, "credential-store": 1, model: 1, offline: 1, "rate-limit": 1, provider: 1, "session-write": 1 } satisfies Record<TuiRecovery["category"], 1>) as readonly TuiRecovery["category"][];

/** Every startup recovery category that `startupFailureCategory` can return. */
export const STARTUP_RECOVERY_CATEGORIES = ["auth", "credential-store", "model", "provider"] as const satisfies readonly ReturnType<typeof startupFailureCategory>[];

/** Classify startup adapter failures before showing any provider or OS diagnostic text. */
export function startupFailureCategory(message: string): "auth" | "credential-store" | "model" | "provider" {
  if (/Cannot (read|save|delete) credential in the OS secure store|secure store|Secret Service|libsecret/i.test(message)) return "credential-store";
  if (/\b(model|deployment)\b.*\b(unavailable|no longer available|not available|not found|unknown|invalid)|\b(unavailable|unknown|invalid)\s+model\b/i.test(message)) return "model";
  if (/missing.*(api key|credential)|no .*login found|unauthorized|authentication required/i.test(message)) return "auth";
  return "provider";
}

/** Explain a startup failure in words; the action row beneath names every key, and the diagnostic stays out of both. */
export function startupRecoveryMessage(category: "auth" | "credential-store" | "model" | "provider"): string {
  switch (category) {
    case "auth": return "Sign-in needed · Connect to continue";
    case "credential-store": return "Credential storage unavailable · Unlock the secure store";
    case "model": return "Model unavailable · Choose another model";
    case "provider": return "Connection unavailable · Check the details";
  }
}

/** Bound and mask provider diagnostics before optional display. */
export function redactRecoveryDetails(message: string, secrets: readonly string[]): string {
  return redactSecrets(message, secrets)
    .split(/\r?\n/)
    .map(line => /\b(?:payload|body|data)\b["']?\s*[:=]/i.test(line) ? "[provider payload redacted]" : line)
    .join("\n")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 ***")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,})\b/g, "***")
    .replace(/\b(authorization|x-api-key|api-key|api_key|access_token|refresh_token|client_secret|password|session_token|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1: ***")
    .slice(0, 2000);
}

/** Render one resolved setting with secrets masked and structured values summarized. */
export function displaySetting(key: string, value: unknown): string {
  if (key === "openaiAuth" && canonicalOpenAIAuth(value) === "codex") return CHATGPT_ROUTE;
  if (key === "baseUrl" && typeof value === "string") return sanitizeBaseUrl(value);
  if ((key === "git" || key === "undo") && typeof value === "object" && value !== null) return JSON.stringify(value);
  return value === undefined ? "unset" : String(value);
}
