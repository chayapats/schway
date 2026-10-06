import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { createHistoryCollector, historyGitFailure, historyTurnIdentity, type HistoryCollector, type HistoryObservation } from "../history/collector.ts";
import { HISTORY_PAGE_SIZE, MAX_HISTORY_COMMANDS, MAX_HISTORY_FILES, type HistoryCommand, type HistoryOutcome, type HistoryTelemetry } from "../history/records.ts";
import { openHistoryStore, type HistoryRead } from "../history/store.ts";
import { buildHistoryTimeline, type HistoryAttempt, type HistoryTimeline, type HistoryTurn } from "../history/timeline.ts";
import { combineHistoryTelemetry } from "../history/telemetry.ts";
import { collectUndoEvidence, describeUndoLimits, observeUndoFile, undoTargetVerdict, type UndoTargetVerdict } from "../undo/evidence.ts";
import type { Session } from "../session/session.ts";
import { formatCount, formatDuration } from "../text/format.ts";
import { parseGitDiff, type GitDiffRow } from "../text/diff.ts";
import { openUndoStore } from "../undo/store.ts";
import { getGitDiffPreview, inspectGitStatus } from "../workspace/git.ts";
import type { TurnOutcome } from "./controller-types.ts";
import { LOADING_CURRENT_DIFF, WORKSPACE_REVIEW_STATES, pathStateNote } from "./review-scope.ts";
import { TurnLayer } from "./controller-turn.ts";
import { SESSION_BLOCKED_HINT } from "./running-hints.ts";

/** History has no reload key, so a failed current read names Esc; Enter on the file then reads it again. */
export const HISTORY_CURRENT_DIFF_FAILED = "Current diff unavailable · Esc back";

/** What `/undo` would do now, read from durable undo manifests without changing them. */
export interface HistoryUndoState {
  /** False when undo data could not be read, so no eligibility is claimed. */
  known: boolean;
  /** `/undo` refuses before selecting a turn: no workspace or home, or blocked session storage. */
  blocked?: "no-workspace" | "session-write";
  /** Accepted turn `/undo` selects now, if any. */
  targetTurnId?: string;
  targetOrdinal?: number;
  /** What `/undo` shows for the target now: a preview, the all-changed-since note, or a read-only nothing-to-undo panel. */
  targetVerdict?: UndoTargetVerdict;
  /** Turns that still have saved file pre-images. */
  preImages: readonly string[];
}

/** Read-only timeline panel state: newest turns first, revealed in pages, with saved evidence or current content on request. */
export interface HistorySnapshot {
  view: "list" | "detail" | "current";
  loading: boolean;
  /** Short read problem shown above the list; diagnostics live in `details`. */
  notice?: string;
  details: string;
  showingDetails: boolean;
  /** Revealed turns only, newest first. */
  turns: HistoryTurn[];
  total: number;
  selected: number;
  /** Selected observed file in the detail view. */
  file: number;
  undo: HistoryUndoState;
  /** Turns of this run whose evidence could not be saved, with the reason kept for details. */
  unsaved: Record<string, string>;
  /** Current Git content for one observed path, read only on request; never historical content. */
  current?: { path: string; turn: number; rows: GitDiffRow[]; loading: boolean };
}

/** Pair each recorded outcome with a glyph and word, distinguishing incomplete and unavailable evidence. */
export function historyOutcomeLabel(turn: Pick<HistoryTurn, "evidence" | "outcome">, unsaved = false): string {
  if (turn.evidence === "missing") return unsaved ? "! Not saved" : "○ Details unavailable";
  return { completed: "✓ Done", failed: "✗ Failed", stopped: "− Stopped", limit: "◌ Limit reached", incomplete: "! Incomplete" }[turn.outcome ?? "incomplete"];
}

/** Semantic tone for an outcome label; the glyph and word carry meaning without color. */
export function historyOutcomeTone(turn: Pick<HistoryTurn, "evidence" | "outcome">): "success" | "error" | "warning" | "muted" {
  if (turn.evidence === "missing") return "muted";
  return turn.outcome === "completed" ? "success" : turn.outcome === "failed" ? "error" : turn.outcome === "incomplete" ? "warning" : "muted";
}

/** Known active time, with unknown attempt durations stated rather than guessed. */
export function historyDurationLabel(turn: Pick<HistoryTurn, "evidence" | "activeMs" | "unknownDurations" | "attempts">): string {
  if (turn.evidence === "missing") return "";
  const known = turn.attempts.length > turn.unknownDurations ? formatDuration(turn.activeMs) : "";
  if (!turn.unknownDurations) return known;
  return known ? `${known} + unknown` : "Time unknown";
}

/** Recorded start time in UTC minutes, matching the session picker's activity format. */
export function historyTimeLabel(turn: Pick<HistoryTurn, "startedAt">, compact = false): string {
  if (!turn.startedAt) return "";
  return compact ? turn.startedAt.slice(5, 16).replace("T", " ") : `${turn.startedAt.slice(0, 16).replace("T", " ")} UTC`;
}

/** Concise file and command totals; totals cover every observation even when lists were shortened. */
export function historyCountsLabel(turn: Pick<HistoryTurn, "evidence" | "files" | "commands" | "attempts" | "incompleteAttempts">, compact = false): string {
  if (turn.evidence === "missing") return "";
  // Without any saved outcome the counts are unknown, never zero; a later incomplete attempt makes them lower bounds.
  if (turn.attempts.length <= turn.incompleteAttempts) return "Counts unknown";
  const count = (value: number, singular: string, plural: string) => turn.incompleteAttempts ? `${value}+ ${plural}` : formatCount(value, singular, plural);
  return `${count(turn.files.total, "file", "files")} · ${compact ? count(turn.commands.total, "cmd", "cmds") : count(turn.commands.total, "command", "commands")}`;
}

/** Task excerpt for display, marking shortened and hidden tasks. */
export function historyTaskLabel(turn: Pick<HistoryTurn, "task" | "taskTruncated" | "taskHidden">): string {
  if (turn.taskHidden) return "Command or sensitive task hidden";
  return turn.task ? `${turn.task}${turn.taskTruncated ? "…" : ""}` : "No task text";
}

/** One command summary with its observed ending and, when measured, its run time excluding approval wait; an exit code describes the command only. */
export function historyCommandLine(command: HistoryCommand): { glyph: string; text: string; tone: "success" | "warning" | "muted" | "error" } {
  const text = `${command.command}${command.commandTruncated ? "…" : ""}`;
  const ran = command.durationMs === undefined ? "" : ` · ${formatDuration(Math.max(0, command.durationMs - (command.approvalWaitMs ?? 0)))}`;
  if (command.status === "cancelled") return { glyph: "−", text: `${text} · Stopped${ran}`, tone: "muted" };
  if (command.ended === "timed-out") return { glyph: "!", text: `${text} · Timed out${ran}`, tone: "error" };
  if (command.status === "error" && command.exitCode === null) return { glyph: "!", text: `${text} · Tool error${ran}`, tone: "error" };
  if (command.exitCode !== null) return command.exitCode === 0 ? { glyph: "✓", text: `${text} · Exit 0${ran}`, tone: "success" } : { glyph: "!", text: `${text} · Exit ${command.exitCode}${ran}`, tone: "warning" };
  return { glyph: "−", text: `${text} · ${command.ended === "stopped" ? "Stopped" : "No exit observed"}${ran}`, tone: "muted" };
}

/** Turn telemetry over attempts that recorded it; `complete` is false when another attempt recorded none, making totals lower bounds. */
export function historyTurnTelemetry(turn: Pick<HistoryTurn, "evidence" | "attempts">): { telemetry: HistoryTelemetry; complete: boolean } | undefined {
  if (turn.evidence === "missing") return undefined;
  const recorded = turn.attempts.flatMap(attempt => attempt.telemetry ? [attempt.telemetry] : []);
  return recorded.length ? { telemetry: combineHistoryTelemetry(recorded), complete: recorded.length === turn.attempts.length } : undefined;
}

/** Cached share of input when every call reported both counts with `0 ≤ cached ≤ input` per call; a lower bound when only some calls reported cached counts; otherwise not reported. */
export function historyCacheLabel(telemetry: HistoryTelemetry, complete = true): string {
  const { input, cachedInput } = telemetry.tokens;
  const calls = telemetry.modelCalls;
  if (!calls) return "";
  const allInput = complete && input.reportedCalls === calls;
  const share = () => input.total ? Math.floor((cachedInput.total / input.total) * 100) : 0;
  // A call whose cached count exceeded its own input makes every cache figure untrustworthy.
  if (!cachedInput.reportedCalls || cachedInput.inconsistentCalls || (allInput && cachedInput.total > input.total)) return "Cache not reported";
  if (allInput) return `${share()}%${complete && cachedInput.reportedCalls === calls ? "" : "+"} cached`;
  // Without every input count no share can be bounded, but the reported cached tokens are a lower bound.
  return `${cachedInput.total.toLocaleString("en-US")}+ tokens cached`;
}

/** Muted detail segments such as `Model 2m 42s`, `Tools 5m 42s` and `81% cached`; empty for turns without telemetry, never zeros. */
export function historyTimingSegments(turn: Pick<HistoryTurn, "evidence" | "attempts">): { times: string[]; cache: string } {
  const summary = historyTurnTelemetry(turn);
  if (!summary) return { times: [], cache: "" };
  const { telemetry, complete } = summary;
  const bound = complete ? "" : "+";
  const times = [telemetry.modelCalls ? `Model ${formatDuration(telemetry.modelMs)}${bound}` : "", telemetry.toolCalls ? `Tools ${formatDuration(telemetry.toolMs)}${bound}` : ""].filter(Boolean);
  return { times, cache: historyCacheLabel(telemetry, complete) };
}

/** Fit the timing line to `columns`, dropping the cache segment before any time segment. */
export function historyTimingLine(turn: Pick<HistoryTurn, "evidence" | "attempts">, columns: number): string {
  const { times, cache } = historyTimingSegments(turn);
  const full = [...times, cache].filter(Boolean).join(" · ");
  return Bun.stringWidth(full) <= columns || !times.length ? full : times.join(" · ");
}

/** F2 evidence lines for one attempt's timing and tokens; legacy attempts say nothing was recorded. */
export function historyTelemetryDetails(attempt: Pick<HistoryAttempt, "telemetry" | "outcome">): string[] {
  const telemetry = attempt.telemetry;
  if (!telemetry) return [attempt.outcome ? "  Timing and token details were not recorded for this attempt." : "  Timing and token details are unknown (no outcome recorded)."];
  const first = telemetry.firstDelta;
  const firstOutput = !telemetry.modelCalls ? "" : !first ? " · no text or thinking before completion"
    : ` · first output ${first.minMs === first.maxMs ? formatDuration(first.minMs) : `${formatDuration(first.minMs)}–${formatDuration(first.maxMs)}`}${first.calls < telemetry.modelCalls ? ` (${first.calls} of ${formatCount(telemetry.modelCalls, "call")})` : ""}`;
  const retries = telemetry.retries || telemetry.retryWaitMs ? ` · ${formatCount(telemetry.retries, "retry", "retries")}, ${formatDuration(telemetry.retryWaitMs)} backoff` : " · no retries";
  const token = (label: string, total: HistoryTelemetry["tokens"]["input"]) => (!total.reportedCalls ? `${label} not reported`
    : `${label} ${total.total.toLocaleString("en-US")}${total.reportedCalls < telemetry.modelCalls ? ` (${total.reportedCalls} of ${formatCount(telemetry.modelCalls, "call")} reported)` : ""}`)
    + (total.inconsistentCalls ? ` (ignored ${formatCount(total.inconsistentCalls, "call")} that exceeded the total)` : "");
  const { input, cachedInput, output, reasoning } = telemetry.tokens;
  return [
    telemetry.modelCalls ? `  Model: ${formatCount(telemetry.modelCalls, "call")} · ${formatDuration(telemetry.modelMs)}${firstOutput}${retries}` : "  Model: no calls",
    telemetry.toolCalls ? `  Tools: ${formatCount(telemetry.toolCalls, "timed call")} · ${formatDuration(telemetry.toolMs)} wall time${telemetry.approvalWaitMs ? ` · ${formatDuration(telemetry.approvalWaitMs)} approval wait` : ""}`
      : "  Tools: no timed calls",
    ...(telemetry.modelCalls ? [`  Tokens: ${[token("input", input), token("cached input", cachedInput), token("output", output), token("reasoning", reasoning)].join(" · ")}`] : []),
  ];
}

/** Durable undo outcome or current `/undo` eligibility for one turn, never offering rollback from the timeline. */
export function historyUndoLine(turn: Pick<HistoryTurn, "turnId" | "undo" | "files" | "evidence" | "attempts" | "incompleteAttempts">, undo: HistoryUndoState): string {
  const recorded = turn.undo.at(-1);
  if (recorded) {
    const reverted = recorded.reverted.length, skipped = recorded.skipped.length;
    return `Undone · ${formatCount(reverted, "file")} reverted${skipped ? ` · ${skipped} skipped` : ""}`;
  }
  // Missing or unfinalized evidence cannot show whether the turn edited files.
  if (turn.evidence === "missing" || turn.attempts.length <= turn.incompleteAttempts || !undo.known) return "Undo status unknown · /undo preview";
  if (undo.blocked === "session-write") return `Undo blocked · ${SESSION_BLOCKED_HINT}`;
  if (undo.blocked === "no-workspace") return "Nothing to undo now";
  if (!turn.incompleteAttempts && !turn.files.items.some(file => file.source === "tool")) return "No file edits to undo";
  if (undo.targetTurnId === turn.turnId) return undo.targetVerdict === "preview" ? "Undo available · /undo previews this turn"
    : undo.targetVerdict === "changed-since" ? "Every file changed since · nothing to undo" : "Nothing to undo · /undo shows why";
  if (!undo.preImages.includes(turn.turnId)) return "Undo unavailable · pre-images not kept";
  return undo.targetOrdinal && undo.targetVerdict === "preview" ? `Not the undo target · /undo previews turn ${undo.targetOrdinal}` : "Nothing to undo now";
}

/** Build F2 evidence notes for the list or one turn; caveats stay here instead of the primary view. */
export function historyDetailsText(state: Pick<HistorySnapshot, "unsaved"> & { read?: Pick<HistoryTimeline, "status" | "rejected" | "tornTail" | "elsewhere"> }, turn?: HistoryTurn): string {
  const lines: string[] = [];
  if (turn) {
    if (turn.evidence === "missing") {
      const reason = state.unsaved[turn.turnId];
      lines.push(reason ? `History was not saved for this turn: ${reason}. The conversation and tool results are saved normally.`
        : "No saved history exists for this turn. It ran before history was recorded, or its evidence was not saved. Nothing is rebuilt from conversation text.");
    } else {
      turn.attempts.forEach((attempt, index) => {
        const git = attempt.git === undefined ? "Git evidence unknown (no outcome recorded)"
          : attempt.git.status === "captured" ? "Git snapshots captured before and after the attempt"
          : `Git snapshots unavailable: ${{ off: "change tracking is off", "no-workspace": "no workspace was active", "non-git": "not a Git workspace", failed: "the snapshot failed", "not-captured": "no snapshot was captured", headless: "headless runs take no snapshots" }[attempt.git.reason]}${attempt.git.detail ? ` (${attempt.git.detail})` : ""}`;
        lines.push(`Attempt ${index + 1}: ${attempt.mode === "tui" ? "interactive" : "headless"} · ${attempt.workspaceRoot} · started ${historyTimeLabel(attempt)} · ${attempt.outcome ? historyOutcomeLabel({ evidence: "recorded", outcome: attempt.outcome }) : "no outcome recorded"} · ${attempt.activeMs === null ? "time unknown" : formatDuration(attempt.activeMs)}`);
        lines.push(`  ${git}`);
        lines.push(...historyTelemetryDetails(attempt));
      });
      if (turn.incompleteAttempts) lines.push(`${formatCount(turn.incompleteAttempts, "attempt")} saved a start but no outcome, after a crash, forced quit or failed write. Its files, commands and time are unknown, so counts below are lower bounds.`);
      lines.push(`${formatCount(turn.toolResults, "tool result")}; ${formatCount(turn.failedTools, "failed tool")}.`);
      lines.push(`Commands: ${turn.commands.exitZero} exited 0, ${turn.commands.nonzero} nonzero, ${turn.commands.unknown} without an observed exit.`);
      if (turn.commands.truncated) lines.push(`The command list shows ${turn.commands.items.length} of ${turn.commands.total} summaries; each keeps at most 200 characters.`);
      if (turn.files.truncated) lines.push(`The file list shows ${turn.files.items.length} of ${turn.files.total} observed paths${turn.oversized ? `; ${formatCount(turn.oversized, "oversized path")} could not be stored` : ""}.`);
      if (turn.attempts.some(attempt => attempt.telemetry)) lines.push(
        "Token counts are what the provider reported, not billing. Cached input is part of input and reasoning is part of output.",
        "Model time adds every model attempt, including failed ones. Tool time is wall time with at least one tool running, so parallel tools count once; approval waits are part of it.",
        "Command times exclude approval waits. No first output means no text or thinking arrived before the call completed.",
      );
    }
    lines.push("");
  }
  const read = state.read;
  if (read?.status === "unsupported") lines.push("This session's history was written by a newer Schway build, so its details are not shown.");
  if (read?.status === "unreadable") lines.push("The history file could not be read or validated, so details are unavailable. It was not changed.");
  if (read && (read.rejected || read.tornTail)) lines.push(`Skipped ${formatCount(read.rejected + (read.tornTail ? 1 : 0), "damaged or oversized record")}. History is never repaired on read.`);
  lines.push(
    "History is recorded while turns run and kept beside the saved session. It is opened offline and read-only.",
    "Outcomes and exit codes are what the runtime observed. A completed turn or exit 0 does not prove that tests passed.",
    "File rows come from successful file-tool results and, when change tracking captured snapshots, Git before/after comparisons. They do not identify exclusive authorship; concurrent external edits can appear.",
    "Line counts add every file-tool edit in the turn, so repeated edits can exceed the net change.",
    `Records keep the first ${MAX_HISTORY_COMMANDS} commands and ${MAX_HISTORY_FILES} files; totals still count every observation.`,
    "Current diff reads the working tree now on request. It is never the exact patch of an earlier turn.",
  );
  return lines.join("\n");
}

/** Interactive history panel and per-turn evidence collection layered on the shared turn runner. */
export abstract class HistoryLayer extends TurnLayer {
  private historyAttempt?: { collector: HistoryCollector; signal: AbortSignal };
  private readonly historyUnsaved = new Map<string, string>();
  private historyState?: { generation: number; identity: string; snapshot: HistorySnapshot; timeline?: HistoryTimeline; revealed: number };
  private historyGeneration = 0;
  private historyCache?: { state: object; key: string; snapshot: HistorySnapshot };

  /** History follows the saved-session lifecycle: only a persisted session under this home gets a sidecar. */
  private historyEnabled(session: Session = this.session): boolean {
    return !!this.home && "persisted" in session && (session as { persisted?: unknown }).persisted === true;
  }

  /** Persist the attempt start before the baseline capture and execution of each accepted turn. */
  protected override async captureTurnBaseline(signal: AbortSignal): Promise<void> {
    this.historyAttempt = undefined;
    const identity = this.historyEnabled() && !this.disposed ? historyTurnIdentity(this.session, this.workspace?.root, "tui") : undefined;
    if (identity && this.activeAbort?.signal === signal) {
      const collector = createHistoryCollector({ store: openHistoryStore({ home: this.home! }), identity, secrets: this.secrets, clock: this.activityClock, session: this.session });
      this.historyAttempt = { collector, signal };
      await collector.start();
    }
    return super.captureTurnBaseline(signal);
  }

  /** Feed the owning attempt's runtime events to its collector after native observers. */
  protected override observeRuntimeEvent(event: RuntimeEvent): void {
    super.observeRuntimeEvent(event);
    const attempt = this.historyAttempt;
    if (attempt && attempt.signal === this.activeAbort?.signal) attempt.collector.observe(event);
  }

  /** Finalize the attempt with the settled outcome and only the Git evidence this turn already captured. */
  protected override async finishOutcome(reason?: TurnOutcome["reason"]): Promise<void> {
    await super.finishOutcome(reason);
    const attempt = this.historyAttempt;
    if (!attempt || attempt.signal !== this.activeAbort?.signal || this.disposed || !this.outcome) return;
    this.historyAttempt = undefined;
    const outcome: HistoryOutcome = this.outcome.reason === "cancelled" ? "stopped" : this.outcome.reason;
    const state = await attempt.collector.finalize({ outcome, observation: this.historyObservation() });
    if (state.state !== "unsaved" || this.disposed) return;
    const { sessionId, turnId } = attempt.collector.identity;
    this.historyUnsaved.set(`${sessionId}/${turnId}`, state.reason);
    this.notice("History not saved · /history shows gaps · F2 details", `History evidence for this turn was not saved: ${state.reason}. The conversation and tool results were saved normally.`);
  }

  /** Describe observational Git evidence from existing captures without starting any Git process. */
  private historyObservation(): HistoryObservation {
    if (this.gitChangeTracking() === "off") return { status: "unavailable", reason: "off" };
    if (!this.workspace) return { status: "unavailable", reason: "no-workspace" };
    if (this.gitSnapshotError) return historyGitFailure(this.gitSnapshotError);
    if (this.gitComparison && this.gitBaseline) {
      const root = this.gitBaseline.root;
      return { status: "captured", paths: this.gitShellPaths.map(path => resolve(root, path)) };
    }
    return { status: "unavailable", reason: "not-captured" };
  }

  /** Open the read-only timeline for the selected ancestry; reading is offline and never writes. */
  async historyCommand(args: string): Promise<boolean> {
    if (this.disposed || this.running) return false;
    if (args.trim()) { this.fail("Usage: /history"); return false; }
    this.closeChangeReview();
    this.closeUndoPreview();
    const generation = ++this.historyGeneration;
    const identity = this.historyIdentity();
    const session = this.session;
    const snapshot: HistorySnapshot = { view: "list", loading: true, details: "", showingDetails: false, turns: [], total: 0, selected: 0, file: 0, undo: { known: false, preImages: [] }, unsaved: {} };
    this.historyState = { generation, identity, snapshot, revealed: 0 };
    const empty: HistoryRead = { status: "missing", starts: [], finalizes: [], rejected: 0, tornTail: false };
    const read = this.historyEnabled(session) ? await openHistoryStore({ home: this.home! }).read(session.rootId).catch((): HistoryRead => ({ ...empty, status: "unreadable" })) : empty;
    const undo = await this.historyUndoState(session);
    const state = this.historyState;
    if (this.disposed || state?.generation !== generation || this.historyIdentity() !== identity) return false;
    const timeline = buildHistoryTimeline(read, session, this.secrets);
    state.timeline = timeline;
    state.revealed = Math.min(HISTORY_PAGE_SIZE, timeline.turns.length);
    snapshot.loading = false;
    snapshot.total = timeline.turns.length;
    snapshot.undo = { ...undo, ...(undo.targetTurnId ? { targetOrdinal: timeline.turns.find(turn => turn.turnId === undo.targetTurnId)?.ordinal } : {}) };
    snapshot.unsaved = Object.fromEntries([...this.historyUnsaved].filter(([key]) => key.startsWith(`${session.rootId}/`)).map(([key, reason]) => [key.slice(session.rootId.length + 1), reason]));
    snapshot.notice = timeline.status === "unsupported" ? "Newer history format · F2 details"
      : timeline.status === "unreadable" ? "History unreadable · F2 details"
      : timeline.rejected || timeline.tornTail ? "Some records skipped · F2 details" : undefined;
    this.refreshHistoryDetails();
    return true;
  }

  /** Decide what `/undo` would do now with the same gates, target selection and per-file check, reading but never writing. */
  private async historyUndoState(session: Session): Promise<HistoryUndoState> {
    if (this.sessionWriteBlocked) return { known: true, blocked: "session-write", preImages: [] };
    if (!this.home || !this.workspace) return { known: true, blocked: "no-workspace", preImages: [] };
    try {
      const store = openUndoStore({ home: this.home });
      const manifests = await store.list(session.rootId);
      const users = session.items.filter(item => item.type === "user").map(item => item.id);
      const undone = new Set(session.entries.flatMap(entry => entry.item.type === "turn_undo" ? [entry.item.turnId] : []));
      const evidence = collectUndoEvidence(manifests, users, undone), target = evidence.target;
      const verdict = target ? undoTargetVerdict(await Promise.all(target.files.map(file => observeUndoFile(store, target, file))), describeUndoLimits(evidence).unsaved.length) : undefined;
      return { known: true, ...(target ? { targetTurnId: target.turnId, targetVerdict: verdict } : {}), preImages: manifests.map(manifest => manifest.turnId) };
    } catch { return { known: false, preImages: [] }; }
  }

  /** Return a redacted copy of the open history panel. */
  protected historySnapshot(): HistorySnapshot | undefined {
    const state = this.historyState;
    if (!state) return undefined;
    // Renders read the snapshot many times per key; reuse one frozen copy until the panel state changes.
    const live = state.snapshot;
    const key = JSON.stringify([state.generation, state.revealed, live.view, live.loading, live.selected, live.file, live.showingDetails, live.details, live.notice,
      live.current?.path, live.current?.loading, live.current?.rows.length, this.secrets.length]);
    if (this.historyCache?.state === state && this.historyCache.key === key) return this.historyCache.snapshot;
    const snapshot = this.redactHistory(structuredClone({ ...live, turns: state.timeline?.turns.slice(0, state.revealed) ?? [] }));
    deepFreeze(snapshot);
    this.historyCache = { state, key, snapshot };
    return snapshot;
  }

  /** Mask known secrets in every user-derived string of a copied snapshot. */
  private redactHistory(snapshot: HistorySnapshot): HistorySnapshot {
    if (!this.secrets.length) return snapshot;
    const redact = (text: string) => redactSecrets(text, this.secrets);
    snapshot.details = redact(snapshot.details);
    for (const turn of snapshot.turns) {
      if (turn.task) turn.task = redact(turn.task);
      for (const file of turn.files.items) file.path = redact(file.path);
      for (const command of turn.commands.items) command.command = redact(command.command);
    }
    if (snapshot.current) { snapshot.current.path = redact(snapshot.current.path); snapshot.current.rows = snapshot.current.rows.map(row => ({ ...row, text: redact(row.text) })); }
    return snapshot;
  }

  /** Snapshot field for the open history panel, omitted while closed. */
  protected historySnapshotField(): { history?: HistorySnapshot } {
    const history = this.historySnapshot();
    return history ? { history } : {};
  }

  /** Move the turn selection, revealing the next page past the last revealed turn; in detail, move the observed-file selection. */
  moveHistory(delta: number): void {
    const state = this.historyState, snapshot = state?.snapshot;
    if (!state || !snapshot || snapshot.loading || !state.timeline) return;
    if (snapshot.view === "detail") {
      const count = state.timeline.turns[snapshot.selected]?.files.items.length ?? 0;
      if (count) snapshot.file = Math.max(0, Math.min(count - 1, snapshot.file + delta));
      return;
    }
    if (snapshot.view !== "list" || !state.timeline.turns.length) return;
    let next = snapshot.selected + delta;
    if (next >= state.revealed && state.revealed < state.timeline.turns.length) state.revealed = Math.min(state.timeline.turns.length, state.revealed + HISTORY_PAGE_SIZE);
    next = Math.max(0, Math.min(state.revealed - 1, next));
    snapshot.selected = next;
  }

  /** Open saved evidence for the selected turn without reading Git or file content. */
  openHistoryDetail(): boolean {
    const snapshot = this.historyState?.snapshot;
    if (!snapshot || snapshot.loading || snapshot.view !== "list" || !snapshot.total) return false;
    snapshot.view = "detail";
    snapshot.file = 0;
    snapshot.showingDetails = false;
    this.refreshHistoryDetails();
    return true;
  }

  /** Toggle evidence notes in place for the list or the open turn. */
  toggleHistoryDetails(): boolean {
    const snapshot = this.historyState?.snapshot;
    if (!snapshot || snapshot.loading || snapshot.view === "current") return false;
    snapshot.showingDetails = !snapshot.showingDetails;
    return true;
  }

  /** Read the current Git diff of the selected observed path on request, labelled as current content. */
  async inspectHistoryCurrent(): Promise<boolean> {
    const state = this.historyState, snapshot = state?.snapshot;
    const turn = state?.timeline?.turns[snapshot?.selected ?? -1];
    const file = turn?.files.items[snapshot?.file ?? -1];
    if (!state || !snapshot || snapshot.view !== "detail" || !turn || !file || this.disposed) return false;
    const generation = ++this.historyGeneration;
    state.generation = generation;
    const current: NonNullable<HistorySnapshot["current"]> = { path: file.path, turn: turn.ordinal, rows: [{ sign: " ", text: LOADING_CURRENT_DIFF }], loading: true };
    snapshot.view = "current";
    snapshot.showingDetails = false;
    snapshot.current = current;
    const settle = (rows: readonly (string | GitDiffRow)[]) => {
      current.rows = rows.map(row => typeof row === "string" ? { sign: " " as const, text: row } : row);
      current.loading = false;
      return true;
    };
    const stale = () => this.disposed || this.historyState !== state || state.generation !== generation || snapshot.current !== current;
    // Off mode and missing workspaces read nothing, exactly like current-changes review.
    if (this.gitChangeTracking() === "off") return settle(WORKSPACE_REVIEW_STATES.off);
    if (!this.workspace) return settle(WORKSPACE_REVIEW_STATES.noWorkspace);
    const root = turn.attempts.at(-1)?.workspaceRoot ?? this.workspace.root;
    const absolute = isAbsolute(file.path) ? file.path : resolve(root, file.path);
    const status = await inspectGitStatus(this.workspace.root);
    if (stale()) return false;
    if ("error" in status) return settle([HISTORY_CURRENT_DIFF_FAILED, status.error]);
    if (!status.isGit) return settle(WORKSPACE_REVIEW_STATES.nonGit);
    const inside = relative(status.root, absolute);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return settle([pathStateNote("outside")]);
    const preview = await getGitDiffPreview(status.root, inside);
    if (stale()) return false;
    if ("error" in preview) return settle([HISTORY_CURRENT_DIFF_FAILED, preview.error]);
    if (preview.pathState) return settle([preview.pathState === "unavailable" ? HISTORY_CURRENT_DIFF_FAILED : pathStateNote(preview.pathState)]);
    return settle(parseGitDiff(preview, { includeComparisons: true }));
  }

  /** Step back: current content to its turn, details to evidence, a turn to the same list row, then close. */
  historyBack(): void {
    const snapshot = this.historyState?.snapshot;
    if (!snapshot) return;
    if (snapshot.showingDetails) { snapshot.showingDetails = false; return; }
    if (snapshot.view === "current") { this.historyGeneration++; snapshot.view = "detail"; snapshot.current = undefined; return; }
    if (snapshot.view === "detail") { snapshot.view = "list"; this.refreshHistoryDetails(); return; }
    this.closeHistory();
  }

  /** Close the timeline without touching conversation, files, undo data or the sidecar. */
  closeHistory(): void {
    this.historyGeneration++;
    this.historyState = undefined;
  }

  /** Close history when the conversation it describes is replaced. */
  override replaceSession(...args: Parameters<TurnLayer["replaceSession"]>): void {
    this.closeHistory();
    super.replaceSession(...args);
  }

  /** Rebuild F2 notes for the current list or turn. */
  private refreshHistoryDetails(): void {
    const state = this.historyState;
    if (!state) return;
    const snapshot = state.snapshot;
    const turn = snapshot.view === "list" ? undefined : state.timeline?.turns[snapshot.selected];
    snapshot.details = historyDetailsText({ unsaved: snapshot.unsaved, ...(state.timeline ? { read: state.timeline } : {}) }, turn);
  }

  /** Conversation identity an in-flight history read must still match. */
  private historyIdentity(): string {
    return JSON.stringify([this.sessionId, this.session.rootId, this.session.activeBranchId, this.session.items.length]);
  }
}

/** Freeze a shared snapshot copy so no reader can change what later renders see. */
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}
