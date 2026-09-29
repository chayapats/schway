import { redactSecrets } from "../auth/secrets.ts";
import type { TuiRecovery } from "./controller-types.ts";
import { sanitizeBaseUrl } from "./transcript-format.ts";

/** Plain-language recovery guidance never includes provider diagnostic text. */
export function recoveryMessage(category: TuiRecovery["category"]): string {
  switch (category) {
    case "auth": return "The selected provider rejected its sign-in. Connect again, then continue this saved turn. Completed results remain available.";
    case "credential-store": return "Credential storage is locked or unavailable. Restore OS secure-store access, then retry credential access. Saved task progress remains available.";
    case "model": return "The selected model is unavailable. Choose a model, then continue this saved turn. Completed results remain available.";
    case "offline": return "The provider connection timed out or is offline. Check the connection, then continue this saved turn.";
    case "rate-limit": return "The provider rate limit is still exhausted after retries. Wait for access, then continue this saved turn.";
    case "session-write": return "Could not save progress to this session. Further tool execution stopped. Inspect the visible output and repair storage before starting new work.";
    case "tool": return "A tool failed. Inspect its result before deciding how to proceed; completed effects remain in this session.";
    default: return "The provider could not finish this step. Inspect details or continue this session when ready.";
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
    case "auth": return "Missing credentials. Use /login or connect to the selected provider. Your draft is still in the editor.";
    case "credential-store": return "Credential storage is locked or unavailable. Restore OS secure-store access, then retry credential access. Your draft is still in the editor.";
    case "model": return "The selected model is unavailable. Choose an available model; your draft is still in the editor.";
    case "provider": return "The selected provider could not be loaded. Inspect details and repair its settings; your draft is still in the editor.";
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
