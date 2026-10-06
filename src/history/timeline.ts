import type { TurnUndoRecord } from "../conversation/types.ts";
import type { Session } from "../session/session.ts";
import { MAX_HISTORY_COMMANDS, MAX_HISTORY_FILES, type HistoryCollection, type HistoryCommand, type HistoryFile, type HistoryGitEvidence, type HistoryMode,
  type HistoryOutcome, type HistoryTelemetry, type HistoryTurnFinalize, type HistoryTurnStart } from "./records.ts";
import { historyExcerpt } from "./sanitize.ts";
import type { HistoryRead } from "./store.ts";

/** One execution attempt of an accepted turn, finalized or left incomplete. */
export interface HistoryAttempt {
  attemptId: string;
  mode: HistoryMode;
  workspaceRoot: string;
  startedAt: string;
  outcome?: HistoryOutcome;
  finishedAt?: string;
  activeMs: number | null;
  git?: HistoryGitEvidence;
  /** Model and tool timing with token totals; absent when the attempt recorded none. */
  telemetry?: HistoryTelemetry;
}

/** Folded evidence for one accepted user turn on the selected ancestry; absent evidence stays explicit. */
export interface HistoryTurn {
  turnId: string;
  /** One-based position on the selected ancestry. */
  ordinal: number;
  task?: string;
  taskTruncated: boolean;
  taskHidden: boolean;
  /** recorded: at least one attempt start exists; missing: no saved evidence for this turn. */
  evidence: "recorded" | "missing";
  /** Latest authoritative attempt outcome, or incomplete when the latest attempt never finalized. */
  outcome?: HistoryOutcome | "incomplete";
  startedAt?: string;
  finishedAt?: string;
  /** Sum of known active durations. */
  activeMs: number;
  /** Attempts whose active duration is unknown, including incomplete ones. */
  unknownDurations: number;
  /** Attempts with a saved start but no saved outcome; their counts are unknown, so totals are lower bounds. */
  incompleteAttempts: number;
  attempts: HistoryAttempt[];
  toolResults: number;
  failedTools: number;
  commands: HistoryCollection<HistoryCommand> & { exitZero: number; nonzero: number; unknown: number };
  files: HistoryCollection<HistoryFile>;
  oversized: number;
  /** Durable undo outcomes recorded for this turn on any branch. */
  undo: Pick<TurnUndoRecord, "reverted" | "skipped">[];
}

/** Turns of the selected ancestry, newest first, plus what the read rejected. */
export interface HistoryTimeline {
  status: HistoryRead["status"];
  turns: HistoryTurn[];
  rejected: number;
  tornTail: boolean;
  /** Saved starts whose turn is not on this ancestry or whose graph placement does not match. */
  elsewhere: number;
}

/** Fold validated records onto the selected ancestry without repairing, inventing or reattaching evidence. */
export function buildHistoryTimeline(read: HistoryRead, session: Pick<Session, "items" | "entries">, secrets: readonly string[] = []): HistoryTimeline {
  const parents = new Map(session.entries.map(entry => [entry.item.id, entry.parentId]));
  const users = session.items.filter(item => item.type === "user");
  const onPath = new Map(users.map((user, index) => [user.id, index + 1]));
  const starts = new Map<string, HistoryTurnStart[]>();
  let elsewhere = 0;
  const startByAttempt = new Map<string, HistoryTurnStart>();
  for (const start of read.starts) {
    // Evidence attaches only to the exact accepted user record at its saved graph position.
    if (!onPath.has(start.turnId) || parents.get(start.turnId) !== start.parentId || startByAttempt.has(start.attemptId)) { elsewhere++; continue; }
    startByAttempt.set(start.attemptId, start);
    starts.set(start.turnId, [...(starts.get(start.turnId) ?? []), start]);
  }
  // The highest revision per attempt is authoritative; a duplicate revision keeps its first delivery.
  const finals = new Map<string, HistoryTurnFinalize>();
  for (const record of read.finalizes) {
    const start = startByAttempt.get(record.attemptId);
    if (!start || start.turnId !== record.turnId) continue;
    const prior = finals.get(record.attemptId);
    if (!prior || record.revision > prior.revision) finals.set(record.attemptId, record);
  }
  const undo = new Map<string, Pick<TurnUndoRecord, "reverted" | "skipped">[]>();
  for (const entry of session.entries) if (entry.item.type === "turn_undo") undo.set(entry.item.turnId, [...(undo.get(entry.item.turnId) ?? []), { reverted: entry.item.reverted, skipped: entry.item.skipped }]);
  const turns = users.map((user, index): HistoryTurn => {
    const attempts = starts.get(user.id) ?? [];
    const first = attempts[0];
    const excerpt = first ? { text: first.task, truncated: !!first.taskTruncated, hidden: !!first.taskHidden }
      : historyExcerpt(user.type === "user" ? user.content.map(block => block.text).join(" ") : "", secrets);
    const turn: HistoryTurn = { turnId: user.id, ordinal: index + 1, ...(excerpt.text ? { task: excerpt.text } : {}), taskTruncated: excerpt.truncated, taskHidden: excerpt.hidden,
      evidence: attempts.length ? "recorded" : "missing", activeMs: 0, unknownDurations: 0, incompleteAttempts: 0, attempts: [], toolResults: 0, failedTools: 0,
      commands: { total: 0, exitZero: 0, nonzero: 0, unknown: 0, truncated: false, items: [] }, files: { total: 0, truncated: false, items: [] }, oversized: 0,
      undo: undo.get(user.id) ?? [] };
    const seenCommands = new Set<string>();
    const filesByPath = new Map<string, HistoryFile>();
    let omittedFiles = 0;
    for (const start of attempts) {
      const final = finals.get(start.attemptId);
      turn.attempts.push({ attemptId: start.attemptId, mode: start.mode, workspaceRoot: start.workspaceRoot, startedAt: start.startedAt, activeMs: final?.activeMs ?? null,
        ...(final ? { outcome: final.outcome, finishedAt: final.finishedAt, git: final.git } : {}), ...(final?.telemetry ? { telemetry: final.telemetry } : {}) });
      if (!final || final.activeMs === null) turn.unknownDurations++;
      if (!final) { turn.incompleteAttempts++; continue; }
      turn.activeMs += final.activeMs ?? 0;
      turn.toolResults += final.toolResults;
      turn.failedTools += final.failedTools;
      turn.oversized += final.oversized ?? 0;
      const commands = turn.commands;
      commands.total += final.commands.total; commands.exitZero += final.commands.exitZero; commands.nonzero += final.commands.nonzero; commands.unknown += final.commands.unknown;
      commands.truncated ||= final.commands.truncated;
      for (const command of final.commands.items) {
        if (seenCommands.has(command.id)) continue;
        seenCommands.add(command.id);
        if (commands.items.length < MAX_HISTORY_COMMANDS) commands.items.push(command); else commands.truncated = true;
      }
      turn.files.truncated ||= final.files.truncated;
      omittedFiles += final.files.total - final.files.items.length;
      for (const file of final.files.items) {
        const existing = filesByPath.get(file.path);
        if (!existing) { filesByPath.set(file.path, { ...file }); continue; }
        if (file.source === "tool") existing.source = "tool";
        if (file.added !== undefined) existing.added = (existing.added ?? 0) + file.added;
        if (file.removed !== undefined) existing.removed = (existing.removed ?? 0) + file.removed;
      }
    }
    const merged = [...filesByPath.values()];
    turn.files.total = merged.length + omittedFiles;
    turn.files.items = merged.slice(0, MAX_HISTORY_FILES);
    if (merged.length > MAX_HISTORY_FILES) turn.files.truncated = true;
    const last = turn.attempts.at(-1);
    if (last) {
      turn.outcome = last.outcome ?? "incomplete";
      turn.startedAt = turn.attempts[0]!.startedAt;
      turn.finishedAt = turn.attempts.findLast(attempt => attempt.finishedAt)?.finishedAt;
    }
    return turn;
  });
  return { status: read.status, turns: turns.reverse(), rejected: read.rejected, tornTail: read.tornTail, elsewhere };
}
