import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CREDENTIAL_HEADER_NAMES, redactSecrets } from "../auth/secrets.ts";
import type { RuntimeEvent } from "../agent/events.ts";

/** Default maximum bytes per active diagnostic file. */
export const DIAGNOSTIC_MAX_BYTES = 1_048_576;
/** Default number of retained rotated diagnostic files. */
export const DIAGNOSTIC_ARCHIVES = 3;
/** Default maximum number of records waiting for the disk writer. */
export const DIAGNOSTIC_PENDING = 128;

/** User-local diagnostic destination, separate from resumable session JSONL. */
export function diagnosticPath(home: string): string { return join(home, ".schway", "logs", "diagnostics.jsonl"); }

/** Safe metadata-only log interface for runtime and future internal features. */
export interface DiagnosticSink {
  /** Enqueue bounded, sanitized metadata; never await I/O in the coding loop. */
  record(component: string, event: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error"): void;
  /** Extract safe identifiers/status from a runtime event, without serializing payloads. */
  runtime(event: RuntimeEvent): void;
  /** Wait briefly for queued records during cancellation or orderly shutdown. */
  flush(timeoutMs?: number): Promise<void>;
  /** Stop accepting new records and drain bounded pending writes. */
  close(timeoutMs?: number): Promise<void>;
  /** Number of records dropped due to full buffer or disk failure. */
  readonly dropped: number;
}

/** Configure a local opt-in sink with bounded disk/memory retention and a dynamic session ID. */
export function createDiagnosticSink(options: {
  home: string;
  enabled: boolean;
  destination?: string;
  runId?: string;
  sessionId?: () => string | undefined;
  secrets?: readonly string[];
  limits?: { maxBytes?: number; archives?: number; pending?: number };
}): DiagnosticSink {
  if (!options.enabled) return { record() {}, runtime() {}, async flush() {}, async close() {}, get dropped() { return 0; } };
  const destination = options.destination ?? diagnosticPath(options.home);
  const maxBytes = bounded(options.limits?.maxBytes, DIAGNOSTIC_MAX_BYTES, 256, DIAGNOSTIC_MAX_BYTES);
  const archives = bounded(options.limits?.archives, DIAGNOSTIC_ARCHIVES, 0, 20);
  const pending = bounded(options.limits?.pending, DIAGNOSTIC_PENDING, 1, 1024);
  const queue: string[] = [];
  let dropped = 0;
  let writing: Promise<void> | undefined;
  let stopped = false;
  let failed = false;
  let size: number | undefined;
  const secrets = options.secrets ?? [];
  const pump = () => {
    if (writing || failed || queue.length === 0) return;
    writing = (async () => {
      try {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        size ??= await stat(destination).then(file => file.size, () => 0);
        while (queue.length) {
          const line = queue.shift()!;
          const bytes = Buffer.byteLength(line);
          if (size + bytes > maxBytes) {
            for (let i = archives; i >= 1; i--) {
              const from = i === 1 ? destination : `${destination}.${i - 1}`;
              if (i === archives) await unlink(`${destination}.${i}`).catch(missingOnly);
              await rename(from, `${destination}.${i}`).catch(missingOnly);
            }
            if (archives === 0) await unlink(destination).catch(missingOnly);
            size = 0;
          }
          await appendFile(destination, line, { mode: 0o600 });
          size += bytes;
        }
      } catch {
        failed = true;
        dropped += queue.length + 1;
        queue.length = 0;
      } finally {
        writing = undefined;
        if (queue.length) pump();
      }
    })();
  };
  const sink: DiagnosticSink = {
    get dropped() { return dropped; },
    record(component, event, fields = {}, level = "info") {
      if (stopped || failed) { dropped++; return; }
      if (queue.length >= pending) { dropped++; return; }
      try {
      const record = {
        timestamp: new Date().toISOString(), level,
        runId: options.runId ?? "unknown", sessionId: options.sessionId?.() ?? null,
        component: cleanText(component, secrets).slice(0, 64),
        event: cleanText(event, secrets).slice(0, 64),
        fields: sanitize(fields, secrets),
      };
      let line = JSON.stringify(record);
      if (Buffer.byteLength(line) > 3900) line = JSON.stringify({ ...record, fields: { truncated: true } });
      queue.push(`${line}\n`);
      pump();
      } catch { dropped++; } // Logging must never interrupt the caller or tool settlement.
    },
    runtime(event) {
      // Explicit projection: model text, arguments, tool output/details and provider payloads are never visited.
      switch (event.type) {
        case "agent.started": case "model.finished": sink.record(event.type.split(".")[0]!, event.type); break;
        case "agent.finished": sink.record("agent", event.type, { reason: event.reason }, event.reason === "error" ? "error" : "info"); break;
        case "model.started": sink.record("model", event.type, { provider: event.provider, model: event.model }); break;
        case "model.retry": sink.record("model", event.type, { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, message: event.message }, "warn"); break;
        case "tool.started": sink.record("tool", event.type, { name: event.name, toolCallId: event.toolCallId }); break;
        case "tool.finished": sink.record("tool", event.type, { name: event.name, toolCallId: event.toolCallId, status: event.status }, event.status === "success" ? "info" : "warn"); break;
        case "compaction.started": sink.record("compaction", event.type, { reason: event.reason }); break;
        case "compaction.finished": sink.record("compaction", event.type, { reason: event.reason, status: event.status, ...(event.status === "completed" ? { recordId: event.recordId, firstKeptId: event.firstKeptId } : { message: event.message }) }, event.status === "failed" ? "warn" : "info"); break;
        case "error": sink.record("agent", event.type, { message: event.message }, "error"); break;
        case "model.delta": case "tool.delta": break;
      }
    },
    async flush(timeoutMs = 1500) {
      const drain = async () => { while (writing) await writing; };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    },
    async close(timeoutMs) { stopped = true; await sink.flush(timeoutMs); },
  };
  return sink;
}

function missingOnly(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
const secretField = /(?:secret|password|passwd|token|credential|api.?key|authorization|cookie|private.?key|client.?secret|session.?key)/i;
const rawField = /(?:prompt|payload|content|arguments|body|transcript|stack|source|output|headers)/i;
const urlCredential = /([?&](?:[^=&]*(?:key|token|secret|password|auth|credential|code)[^=&]*)=)[^&#\s]*/gi;
function cleanText(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(urlCredential, "$1***")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, "$1 ***")
    .replace(/\b((?:x-api-key|api[_-]?key|authorization|proxy-authorization|x-auth-token|password|access_token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1***");
}
/** Remove sensitive structured fields, known values, URL credentials and error stacks before JSON serialization. */
export function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return cleanText(item, secrets).slice(0, 256);
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "boolean" || item === null) return item;
    if (depth >= 3 || typeof item !== "object") return undefined;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (item instanceof Error) return { name: visit(item.name, depth + 1), message: visit(item.message, depth + 1), ...(typeof (item as Error & { status?: unknown }).status === "number" ? { status: (item as Error & { status: number }).status } : {}) };
    if (Array.isArray(item)) return item.slice(0, 8).map(entry => visit(entry, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item).slice(0, 24)) {
      if (secretField.test(key) || rawField.test(key) || CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())) continue;
      const safe = visit(entry, depth + 1);
      if (safe !== undefined) result[cleanText(key, secrets).slice(0, 64)] = safe;
    }
    return result;
  };
  return visit(value, 0);
}
