import { redactSecrets } from "../auth/secrets.ts";
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
    case "tool": return "Tool failed · Inspect the result";
    default: return "Request failed · Inspect details before continuing";
  }
}

/** Classify startup adapter failures before showing any provider or OS diagnostic text. */
export function startupFailureCategory(message: string): "auth" | "credential-store" | "model" | "provider" {
  if (/Cannot (read|save|delete) credential in the OS secure store|secure store|Secret Service|libsecret/i.test(message)) return "credential-store";
  if (/\b(model|deployment)\b.*\b(unavailable|no longer available|not available|not found|unknown|invalid)|\b(unavailable|unknown|invalid)\s+model\b/i.test(message)) return "model";
  if (/missing.*(api key|credential)|no .*login found|unauthorized|authentication required/i.test(message)) return "auth";
  return "provider";
}

/** Explain a startup failure while keeping its diagnostic out of the primary row. */
export function startupRecoveryMessage(category: "auth" | "credential-store" | "model" | "provider"): string {
  switch (category) {
    case "auth": return "Sign in to continue · Alt+L sign in";
    case "credential-store": return "Credential storage unavailable · Unlock the secure store";
    case "model": return "Model unavailable · Alt+M choose model";
    case "provider": return "Connection unavailable · Ctrl+I inspect details";
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
  if (key === "baseUrl" && typeof value === "string") return sanitizeBaseUrl(value);
  if (key === "git" && typeof value === "object" && value !== null) return JSON.stringify(value);
  return value === undefined ? "unset" : String(value);
}
