import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sessionsDirectory } from "../session/jsonl.ts";
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
  const destination = resolve(options.destination ?? diagnosticPath(options.home));
  const isDefault = options.destination === undefined;
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
        // Canonicalize existing paths and their nearest existing parent before any append/rotation.
        // A caller-chosen log must never become a durable session record (or rotate one).
        const sessionRoot = await canonicalTarget(sessionsDirectory(options.home));
        const target = await canonicalTarget(destination);
        const inSessions = relative(sessionRoot, target);
        if (inSessions === "" || (inSessions !== ".." && !inSessions.startsWith(`..${sep}`) && !isAbsolute(inSessions))) {
          throw new Error("Diagnostic destination overlaps sessions");
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (isDefault) await requirePrivate(dirname(destination), true);
        await requirePrivate(destination, false);
        size ??= await stat(destination).then(file => file.size, missingSize);
        // Never rotate an oversized or unrelated pre-existing file into retention.
        if (size > maxBytes) throw new Error("Pre-existing diagnostic file exceeds size limit");
        while (queue.length) {
          const line = queue.shift()!;
          const bytes = Buffer.byteLength(line);
          if (bytes > maxBytes) { dropped++; continue; }
          if (size + bytes > maxBytes) {
            for (let i = 1; i <= archives; i++) {
              const archivedSize = await stat(`${destination}.${i}`).then(file => file.size, missingSize);
              if (archivedSize > maxBytes) throw new Error("Pre-existing diagnostic archive exceeds size limit");
            }
            for (let i = archives; i >= 1; i--) {
              const from = i === 1 ? destination : `${destination}.${i - 1}`;
              if (i === archives) await unlink(`${destination}.${i}`).catch(missingOnly);
              await rename(from, `${destination}.${i}`).catch(missingOnly);
            }
            if (archives === 0) await unlink(destination).catch(missingOnly);
            size = 0;
          }
          // O_NOFOLLOW rejects final symlinks; validate the opened inode too, since
          // the destination may change after the pre-open path check.
          await requirePrivate(destination, false);
          const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
          try {
            const info = await file.stat();
            if (!info.isFile() || info.mode & 0o077 || info.nlink !== 1) {
              throw new Error("Diagnostic destination is not a private regular file");
            }
            await file.appendFile(line);
          } finally { await file.close(); }
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
      const sessionId = options.sessionId?.();
      const record = {
        timestamp: new Date().toISOString(), level,
        runId: safeText(options.runId ?? "unknown", secrets, 128),
        sessionId: sessionId === undefined ? null : safeText(sessionId, secrets, 128),
        component: safeText(component, secrets, 64),
        event: safeText(event, secrets, 64),
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
        case "model.usage": sink.record("model", event.type, { phase: event.phase, complete: event.complete, inputCount: event.usage.inputTokens, outputCount: event.usage.outputTokens }); break;
        case "model.retry": sink.record("model", event.type, { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, category: "transient_provider_failure" }, "warn"); break;
        case "tool.denied": sink.record("tool", event.type, { name: event.name, toolCallId: event.toolCallId, mode: event.mode, reason: event.reason }, "warn"); break;
        case "tool.started": sink.record("tool", event.type, { name: event.name, toolCallId: event.toolCallId }); break;
        case "tool.finished": sink.record("tool", event.type, { name: event.name, toolCallId: event.toolCallId, status: event.status }, event.status === "success" ? "info" : "warn"); break;
        case "compaction.started": sink.record("compaction", event.type, { reason: event.reason }); break;
        case "compaction.finished": sink.record("compaction", event.type, { reason: event.reason, status: event.status, ...(event.status === "completed" ? { recordId: event.recordId, firstKeptId: event.firstKeptId } : { category: event.status === "failed" ? "compaction_failure" : "no_compaction" }) }, event.status === "failed" ? "warn" : "info"); break;
        case "error": sink.record("agent", event.type, { category: "runtime_failure" }, "error"); break;
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
function missingSize(error: unknown): number {
  missingOnly(error);
  return 0;
}
async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    missingOnly(error);
    return join(await canonicalTarget(dirname(absolute)), basename(absolute));
  }
}
async function requirePrivate(path: string, directory: boolean): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) { missingOnly(error); return; }
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.mode & 0o077 || (!directory && info.nlink !== 1)) {
    throw new Error("Diagnostic destination is not a private regular file or directory");
  }
}
function safeText(value: string, secrets: readonly string[], max: number): string {
  // Reject, rather than truncate, before sanitizing: a cut credential could reveal a prefix.
  if (value.length > max) return "[oversized]";
  const safe = cleanText(value, secrets);
  return safe.length > max ? "[oversized]" : safe;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
const secretField = /(?:secret|password|passwd|token|credential|api.?key|auth|signature|cookie|private.?key|session.?key)/i;
const rawField = /(?:prompt|payload|content|arguments|body|transcript|stack|source|output|headers)/i;
const urlCredential = /([?&](?:[^=&]*(?:key|token|secret|password|auth|credential|code|signature|sig)[^=&]*)=)[^&#\s]*/gi;
function cleanText(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, url => {
      const start = url.indexOf("://") + 3;
      const authorityEnd = ["/", "?", "#"].reduce((end, marker) => {
        const index = url.indexOf(marker, start);
        return index < 0 ? end : Math.min(end, index);
      }, url.length);
      const authority = url.slice(start, authorityEnd);
      const at = authority.lastIndexOf("@");
      return at < 0 ? url : `${url.slice(0, start)}***@${authority.slice(at + 1)}${url.slice(authorityEnd)}`;
    })
    .replace(urlCredential, "$1***")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, "$1 ***")
    .replace(/\b((?:x-api-key|api[_-]?key|authorization|proxy-authorization|x-auth-token|password|access_token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1***");
}
/** Remove sensitive structured fields, known values, URL credentials and error stacks before JSON serialization. */
export function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return safeText(item, secrets, 256);
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "boolean" || item === null) return item;
    if (depth >= 3 || typeof item !== "object") return undefined;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    // Error messages and stacks can echo an entire prompt; never inspect either by default.
    if (item instanceof Error) {
      const status = Object.getOwnPropertyDescriptor(item, "status");
      return { category: "exception", ...(status && "value" in status && typeof status.value === "number" && Number.isFinite(status.value) ? { status: status.value } : {}) };
    }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (let i = 0; i < Math.min(item.length, 8); i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        result.push(descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : null);
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let examined = 0;
    // for...in is lazy, unlike Object.entries, which evaluates *every* getter before slicing.
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++examined > 24) break;
      if (key.length > 64 || secretField.test(key) || rawField.test(key) || CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const safe = visit(descriptor.value, depth + 1);
      if (safe !== undefined) result[safeText(key, secrets, 64)] = safe;
    }
    return result;
  };
  return visit(value, 0);
}
