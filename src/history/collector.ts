import { isAbsolute, relative, sep } from "node:path";
import type { RuntimeEvent } from "../agent/events.ts";
import type { Session } from "../session/session.ts";
import { buildEditDiff, type DiffHunk } from "../text/diff.ts";
import { historyCallDigest, isHistoryId, isHistoryRoot, isHistorySessionId, MAX_HISTORY_COMMANDS, MAX_HISTORY_FILES,
  type HistoryCommand, type HistoryFile, type HistoryGitEvidence, type HistoryMode, type HistoryOutcome, type HistoryTurnFinalize, type HistoryTurnStart } from "./records.ts";
import { createHistoryTelemetryFold } from "./telemetry.ts";
import { historyCommandSummary, historyDetail, historyExcerpt, historyPath } from "./sanitize.ts";
import { HISTORY_SESSION_MISSING, type HistoryStore } from "./store.ts";

/** Authoritative identity of one execution attempt, taken from the session and workspace it actually ran in. */
export interface HistoryTurnIdentity {
  sessionId: string;
  turnId: string;
  ordinal: number;
  branchId: string;
  parentId: string;
  workspaceRoot: string;
  mode: HistoryMode;
  task: string;
}

/** Whether evidence for this attempt is durable; untracked attempts are skipped silently, unsaved ones are reported. */
export type HistorySaveState = { state: "saved" } | { state: "untracked" } | { state: "unsaved"; reason: string };

/** Observational Git input supplied by the caller from captures it already made; absolute shell paths when captured. */
export type HistoryObservation = HistoryGitEvidence & { paths?: readonly string[] };

/** Renderer-free evidence collector shared by TUI and headless turns. */
export interface HistoryCollector {
  readonly identity: HistoryTurnIdentity;
  readonly attemptId: string;
  /** Persist the attempt start before the attempt counts as tracked; failures never throw. */
  start(): Promise<HistorySaveState>;
  /** Fold one runtime event of this attempt into bounded evidence without blocking execution. */
  observe(event: RuntimeEvent): void;
  /** Append one revisioned outcome; repeating identical evidence writes nothing, and nothing is written for an unsaved start. */
  finalize(input: { outcome?: HistoryOutcome; observation: HistoryObservation }): Promise<HistorySaveState>;
  /** Combined durability of the start and latest finalization. */
  state(): HistorySaveState;
}

/** Derive the identity of the latest accepted user turn on the selected ancestry, or undefined when none can be validated. */
export function historyTurnIdentity(session: Pick<Session, "items" | "entries" | "rootId" | "activeBranchId">, workspaceRoot: string | undefined, mode: HistoryMode): HistoryTurnIdentity | undefined {
  const users = session.items.filter(item => item.type === "user");
  const user = users.at(-1);
  if (!user || user.type !== "user" || !workspaceRoot) return undefined;
  const entry = session.entries.find(candidate => candidate.item.id === user.id);
  if (!entry) return undefined;
  const identity: HistoryTurnIdentity = { sessionId: session.rootId, turnId: user.id, ordinal: users.length, branchId: session.activeBranchId,
    parentId: entry.parentId, workspaceRoot, mode, task: user.content.map(block => block.text).join(" ") };
  return isHistorySessionId(identity.sessionId) && isHistoryId(identity.turnId) && isHistoryId(identity.branchId) && isHistoryId(identity.parentId) && isHistoryRoot(workspaceRoot) ? identity : undefined;
}

/** Create a collector for one attempt; `clock` measures active time and `now` stamps recorded times. */
export function createHistoryCollector(options: { store: HistoryStore; identity: HistoryTurnIdentity; secrets?: readonly string[]; clock?: () => number; now?: () => Date;
  /** Saved conversation used only to name a command whose result carried no structured details, such as a stopped call. */
  session?: Pick<Session, "items"> }): HistoryCollector {
  const { store, identity } = options;
  const secrets = options.secrets ?? [];
  const clock = options.clock ?? (() => performance.now());
  const now = options.now ?? (() => new Date());
  const attemptId = crypto.randomUUID();
  const startedAt = clock();
  let startState: HistorySaveState | undefined;
  let finalizeState: HistorySaveState | undefined;
  let started: Promise<HistorySaveState> | undefined;
  let lastPayload: string | undefined;
  let revision = 0;
  let writes: Promise<unknown> = Promise.resolve();
  let terminal: HistoryOutcome | undefined;
  let toolResults = 0, failedTools = 0, oversized = 0;
  const counts = { exitZero: 0, nonzero: 0, unknown: 0 };
  const commands: HistoryCommand[] = [];
  let commandTotal = 0;
  const seenCalls = new Set<string>();
  const files = new Map<string, HistoryFile>();
  const telemetry = createHistoryTelemetryFold();

  /** Store a workspace-relative `/` path when inside the attempt's root, otherwise the absolute path. */
  const displayPath = (absolute: string): string => {
    const inside = relative(identity.workspaceRoot, absolute);
    return !inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? absolute : inside.split(sep).join("/");
  };
  const addFile = (absolute: string, source: HistoryFile["source"], lines?: { added: number; removed: number }) => {
    const path = historyPath(displayPath(absolute), secrets);
    if (path === undefined) { oversized++; return; }
    let file = files.get(path);
    if (!file) { file = { path, source }; files.set(path, file); }
    else if (source === "tool") file.source = "tool";
    if (lines) { file.added = (file.added ?? 0) + lines.added; file.removed = (file.removed ?? 0) + lines.removed; }
  };

  const collector: HistoryCollector = {
    identity,
    attemptId,
    start() {
      started ??= (async (): Promise<HistorySaveState> => {
        const excerpt = historyExcerpt(identity.task, secrets);
        const record: HistoryTurnStart = { type: "turn_start", version: 1, turnId: identity.turnId, attemptId, ordinal: identity.ordinal,
          branchId: identity.branchId, parentId: identity.parentId, workspaceRoot: identity.workspaceRoot, mode: identity.mode, startedAt: now().toISOString(),
          ...(excerpt.text ? { task: excerpt.text } : {}), ...(excerpt.truncated ? { taskTruncated: true as const } : {}), ...(excerpt.hidden ? { taskHidden: true as const } : {}) };
        try { await store.start(identity.sessionId, record); startState = { state: "saved" }; }
        catch (error) { startState = isCode(error, HISTORY_SESSION_MISSING) ? { state: "untracked" } : { state: "unsaved", reason: reasonOf(error) }; }
        return startState;
      })();
      writes = started;
      return started;
    },
    observe(event) {
      if (event.type === "agent.finished") {
        terminal = event.reason === "error" ? "failed" : event.reason === "cancelled" ? "stopped" : event.reason === "max_turns" ? "limit" : "completed";
        return;
      }
      if (event.type !== "tool.finished") { telemetry.observe(event); return; }
      const digest = historyCallDigest(event.toolCallId);
      // Duplicate delivery of the same result must not add a second observation.
      if (seenCalls.has(digest)) return;
      seenCalls.add(digest);
      telemetry.observe(event);
      toolResults++;
      if (event.status === "error") failedTools++;
      const details = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : undefined;
      if (event.status === "success" && (event.name === "edit" || event.name === "write") && typeof details?.resolvedPath === "string" && isAbsolute(details.resolvedPath)) {
        const hunks = event.name === "edit" ? editHunks(details.hunks) : undefined;
        const lines = hunks ? buildEditDiff(hunks)
          : event.name === "write" && details.created === true && typeof details.lineCount === "number" && Number.isSafeInteger(details.lineCount) && details.lineCount >= 0
            ? { added: details.lineCount, removed: 0 } : undefined;
        addFile(details.resolvedPath, "tool", lines ? { added: lines.added, removed: lines.removed } : undefined);
      }
      if (event.name === "bash") {
        // Exit evidence comes only from structured details, never from result prose.
        const exitCode = typeof details?.exitCode === "number" && Number.isSafeInteger(details.exitCode) && details.exitCode >= 0 ? details.exitCode : null;
        const ended: HistoryCommand["ended"] = details?.timedOut === true ? "timed-out" : exitCode !== null ? "exit" : details && details.exitCode === null ? "stopped" : "unknown";
        counts[exitCode === null ? "unknown" : exitCode === 0 ? "exitZero" : "nonzero"]++;
        commandTotal++;
        if (commands.length < MAX_HISTORY_COMMANDS) {
          const summary = historyCommandSummary(typeof details?.command === "string" ? details.command : requestedCommand(options.session, event.toolCallId) ?? "bash", secrets);
          commands.push({ id: digest, command: summary.text, ...(summary.truncated ? { commandTruncated: true as const } : {}), exitCode, ended,
            status: event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error",
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.durationMs !== undefined && event.approvalWaitMs !== undefined ? { approvalWaitMs: Math.min(event.approvalWaitMs, event.durationMs) } : {}) });
        }
      }
    },
    async finalize(input) {
      const startResult = await (started ?? collector.start());
      if (startResult.state !== "saved") return startResult;
      const observed = input.observation;
      if (observed.status === "captured") for (const path of observed.paths ?? []) if (isAbsolute(path)) addFile(path, "shell");
      const fileItems = [...files.values()];
      const git: HistoryGitEvidence = observed.status === "captured" ? { status: "captured" }
        : { status: "unavailable", reason: observed.reason, ...(observed.detail && historyDetail(observed.detail, secrets) ? { detail: historyDetail(observed.detail, secrets)! } : {}) };
      const body = {
        outcome: input.outcome ?? terminal ?? "failed",
        activeMs: Math.max(0, Math.round(clock() - startedAt)),
        toolResults, failedTools,
        commands: { total: commandTotal, ...counts, truncated: commandTotal > commands.length, items: commands.map(command => ({ ...command })) },
        // Omitted oversized paths still count as observations.
        files: { total: fileItems.length + oversized, truncated: fileItems.length > MAX_HISTORY_FILES || oversized > 0, items: fileItems.slice(0, MAX_HISTORY_FILES).map(file => ({ ...file })) },
        git,
        ...(oversized ? { oversized } : {}),
        telemetry: telemetry.summary(),
      };
      // Idempotent: identical evidence (ignoring time) is not appended again; changed evidence gets the next revision.
      const payload = JSON.stringify({ ...body, activeMs: undefined, telemetry: { ...body.telemetry, modelMs: undefined, firstDelta: undefined, retryWaitMs: undefined, toolMs: undefined, approvalWaitMs: undefined },
        commands: { ...body.commands, items: body.commands.items.map(command => ({ ...command, durationMs: undefined, approvalWaitMs: undefined })) } });
      if (payload === lastPayload && finalizeState) return finalizeState;
      lastPayload = payload;
      const record: HistoryTurnFinalize = { type: "turn_finalize", version: 1, turnId: identity.turnId, attemptId, revision: ++revision, finishedAt: now().toISOString(), ...body };
      const write = writes.then(async (): Promise<HistorySaveState> => {
        try { await store.finalize(identity.sessionId, record); return { state: "saved" }; }
        catch (error) { return { state: "unsaved", reason: reasonOf(error) }; }
      });
      writes = write;
      finalizeState = await write;
      if (finalizeState.state !== "saved") lastPayload = undefined;
      return finalizeState;
    },
    state() {
      if (!startState) return { state: "untracked" };
      if (startState.state !== "saved") return startState;
      return finalizeState ?? startState;
    },
  };
  return collector;
}

/** Map an observed snapshot failure message onto a stored reason without running Git. */
export function historyGitFailure(message: string): HistoryGitEvidence {
  return message.startsWith("Not a Git workspace") ? { status: "unavailable", reason: "non-git", detail: message } : { status: "unavailable", reason: "failed", detail: message };
}

/** The command a saved bash call requested, read from its accepted tool-call arguments. */
function requestedCommand(session: Pick<Session, "items"> | undefined, callId: string): string | undefined {
  for (let index = (session?.items.length ?? 0) - 1; index >= 0; index--) {
    const item = session!.items[index]!;
    if (item.type !== "assistant") continue;
    const call = item.content.find(block => block.type === "tool_call" && block.id === callId);
    if (call?.type !== "tool_call") continue;
    const args = call.arguments as { command?: unknown } | null;
    return args && typeof args === "object" && typeof args.command === "string" ? args.command : undefined;
  }
  return undefined;
}

function editHunks(value: unknown): DiffHunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: DiffHunk[] = [];
  for (const hunk of value) {
    if (!hunk || typeof hunk !== "object" || typeof hunk.startLine !== "number" || typeof hunk.oldText !== "string" || typeof hunk.newText !== "string") return undefined;
    hunks.push({ startLine: hunk.startLine, oldText: hunk.oldText, newText: hunk.newText });
  }
  return hunks;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

/** Short storage reason for details; raw paths and messages stay out of the primary view. */
function reasonOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "EACCES" || code === "EPERM") return "Permission denied";
  if (code === "ENOSPC" || code === "EDQUOT") return "No space left on device";
  if (code === "EROFS") return "Read-only filesystem";
  if (code === "HISTORY_STORE_BUSY") return "History store busy";
  return error instanceof Error ? error.message.slice(0, 200) : "History write failed";
}
