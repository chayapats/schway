import { formatCount } from "../text/format.ts";
import { preferenceLines, preferenceHint, preferenceEscape } from "./preferences-view.ts";
import type { ExitDraftCheckpoint } from "../drafts/exit.ts";
import { isOrdinaryDraft, openDraftStore, type DraftStore } from "../drafts/store.ts";
import { BoxRenderable, TextBufferRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, StyledText, fg, bg, bold, getLinkId, type CliRenderer, type KeyEvent, type PasteEvent, type Selection, type TextChunk } from "@opentui/core";
import { redactSecrets } from "../auth/secrets.ts";
import { bindCredentialInput } from "./credential-input.ts";
import { MAX_BRANCH_TREE_PREVIEW_ENTRIES, type TuiController, type TuiTranscriptEntry, type TuiSnapshot } from "./controller.ts";
import { modelPickerAction, modelPickerName } from "./model-picker.ts";
import { activityDetail, displayText, fitLine, fitStatusAction, shortenWorkspacePath, formatOutcomeLine, statusPill, type StatusTone } from "./presentation.ts";
import { keyHintChunks } from "./hints.ts";
import { RUNNING_DRAFT_HINT, RUNNING_NARROW_HINT, blockedSubmitHint, runningPlaceholder } from "./running-hints.ts";
import { mixColor, resolveTheme, textOn, tint, type ThemeMode } from "./theme.ts";
import { createTicker, easeOut, progress, shimmer, spinnerFrame, type MotionMode } from "./motion.ts";
import { SPLASH_DURATION_MS, SPLASH_ACCENT_DURATION_MS, SPLASH_MIN_SIZE, SplashRenderable } from "./splash.ts";
import type { SplashPolicy } from "./splash-policy.ts";
import { readGitHead } from "./git-head.ts";
import { createTranscriptItem, markdownStyle, type TranscriptItemView } from "./transcript-view.ts";
import { browserUrl, textLinkAt } from "./links.ts";
import { renderedOffsetForFolded, TranscriptSearchIndex, type TranscriptSearchMatch, type TranscriptSearchResult } from "./search.ts";
import { paletteChoices, type CommandChoice, type KeyboardGuideChoice, type PaletteChoice } from "./command-catalog.ts";
import { PALETTE_APPROVAL, PALETTE_NO_MATCHES, PALETTE_PLACEHOLDER, PALETTE_RUNNING, guidanceHeight, guidanceLines, keyboardGuideAvailability, keyboardRowParts, nextPaletteSelection, nothingToInspectReason, paletteDetail, paletteEscape, paletteHint, paletteSections, paletteSelectable } from "./palette.ts";
import { slashEnter, slashPaletteHint, type SlashEnter } from "./palette.ts";
import { formatDiffRows, hasInlineDiff } from "./transcript-format.ts";
import { taskExampleLines, taskExamplesEligible } from "./empty-guidance.ts";
import { currentDiffLabel, emptyFilesLabel, fitPathStart, reviewDetailsLabel, reviewFileBadge, reviewFilesLabel } from "./review-scope.ts";
import { UNDO_REVIEW_DETAILS, UNDO_REVIEW_FILES, UNDO_REVIEW_NO_FILES, undoEscape, undoHeading, undoHint, undoRows } from "./undo-view.ts";
import { createReaderDocument, paintReader, panReader, readerBodyPosition, readerEnd, readerLayout, revealMatch, scrollReader, type ReaderDocument, type ReaderLayout, type ReaderSearch } from "./reader-view.ts";
import type { ReaderPosition } from "./reader.ts";
import { createHistoryPanel } from "./history-view.ts";
import { approvalAction, approvalChoices, approvalHint, approvalPanelLayout, charWrappedRows, type ApprovalPanelLayout } from "./approval-layout.ts";

/** Dependencies for the interactive presentation; submission remains owned by the application. */
export interface ConversationViewOptions {
  controller: TuiController;
  home: string;
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  secrets: string[];
  /** Enable private ordinary-draft checkpoints for the real interactive application. */
  draftPersistence?: boolean;
  submit(value: string, accepted: () => void): Promise<unknown>;
  quit(): void;
  openUrl?(url: string): Promise<void>;
  /** Decorative motion policy; omitted means off so renderer fixtures stay frame-stable. */
  motion?: MotionMode;
  /** Startup decoration policy; full falls back to accent below the splash minimum size. */
  splash?: SplashPolicy;
  /** Notify once after a painted full splash is removed, including input skips. */
  onSplashPlayed?(): void;
  /** Animation clock in milliseconds; defaults to performance.now. */
  now?: () => number;
  /** Version shown beneath the splash wordmark. */
  version?: string;
}

/** Every panel mode the view can show in place of the conversation body; adding a mode requires a catalog screen for it. */
export const PANEL_MODES = Object.freeze(["endpoint", "credential", "callback", "login", "approval", "sessions", "model", "preferences", "tree", "history", "undo", "review", "search", "help", "tool-approval"] as const);
/** One panel mode from `PANEL_MODES`; the view uses "" when the conversation owns the body. */
export type PanelMode = (typeof PANEL_MODES)[number];

/** Build the conversation UI with stable messages, a multiline editor, and transient pickers. */
export function createConversationView(renderer: CliRenderer, options: ConversationViewOptions) {
  const controller = options.controller;
  const motion: MotionMode = options.motion ?? "off";
  const now = options.now ?? (() => performance.now());
  const environmentMode = options.env.SCHWAY_THEME === "light" || options.env.SCHWAY_THEME === "dark" ? options.env.SCHWAY_THEME : undefined;
  let configuredMode = controller.appearanceMode();
  let mode: ThemeMode = configuredMode;
  let theme = resolveTheme(environmentMode ?? mode, renderer.themeMode, options.env);
  let syntax = markdownStyle(theme);
  let destroyed = false;
  let refreshing = false;
  let allExpanded = false;
  const expandedTools = new Set<string>();
  type InspectionTarget = { id: string; index: number } & ({ kind: "code" | "table"; source: string; text: string; title?: string } | { kind: "tool"; callId?: string; name?: string });
  let inspection: InspectionTarget | undefined;
  let previousInspection: InspectionTarget | undefined;
  let inspectionOriginalScroll = 0;
  type InspectionContent = { target: InspectionTarget; source?: string; text: string };
  let renderedInspection: InspectionContent | undefined;
  let paintedInspection: InspectionContent & { node: ReturnType<typeof inspectionNode>; y: number; scroll: number; width: number; height: number } | undefined;
  let scrollToInspection = false;
  let detailsReturn: { key: string; entryId: string; scroll: number; inspection?: InspectionTarget } | undefined;
  let scrollToDetails = false;
  // The reader is a read-only layer above inspection; `readerReturn` is the single
  // checkpoint kept when Esc hands input to a deferred tool approval.
  type ReaderState = { document: ReaderDocument; target: InspectionTarget; key: string; position: ReaderPosition; wrap: boolean; scroll: number; painted: boolean; layout?: ReaderLayout; search?: ReaderSearch };
  let reader: ReaderState | undefined;
  let readerReturn: ReaderState | undefined;
  let readerMeasured: { width: number; height: number; rows: number } | undefined;
  let searchOpen = false;
  let searchOriginalScroll = 0;
  let searchRestoreScroll: number | undefined;
  // Whether the transcript followed the latest output before the open layer paused it; a restore resumes following.
  let restoreFollow = true;
  // A restored follower whose view no longer reaches the bottom (F2 details below it); new output returns to latest.
  let resumeFollowTop: number | undefined;
  // New output arrived while a layer was open; a follower's restore then jumps to the latest output.
  let grewWhileLayered = false;
  let searchScrollToMatch = false;
  let searchAcceptPending = false;
  let searchSelected = -1;
  let searchLastQuery = "";
  let searchResult: TranscriptSearchResult = { matches: [], limited: false };
  const searchIndex = new TranscriptSearchIndex();
  const rows = new Map<string, TranscriptItemView>();
  let sessionKey = "";
  let activeSessionId = "";
  const sessionViewState = new Map<string, { draft: string; cursor: number; scroll: number }>();
  let panelMode: PanelMode | "" = "";
  let savedDraft = "";
  let savedDraftCursor = 0;
  let savedDraftSelection: ReturnType<TextareaRenderable["getSelection"]> = null;
  let savedDraftRevision = 0;
  let panelFingerprint = "";
  let treePreviewKey = "";
  let treePreview: readonly TuiTranscriptEntry[] = [];
  let historyIndex = -1;
  let historyDraft = "";
  const history: string[] = [];
  let editorRevision = 0;
  let observedDraft = "";
  let pendingAcceptance = false;
  let completionIndex = 0;
  let completionId: string | undefined;
  // True once an arrow picks the slash-palette row, so Enter honors it over an exactly typed name.
  let completionChosen = false;
  let discoveryOpen = false;
  let helpOriginalScroll = 0;
  let reviewOriginalScroll = 0;
  let historyOriginalScroll = 0;
  let reviewDetailsScroll: { path?: string; scroll: number } | undefined;
  let reviewRestoreScroll: number | undefined;
  let treeOriginalScroll = 0;
  let sessionOriginalScroll = 0;
  let reviewContent = "";
  let helpInserted = false;
  // Read-only keyboard guidance opened from the help palette; it remembers the query it returns to.
  let helpGuide: { id: KeyboardGuideChoice["id"]; query: string } | undefined;
  let lastQuery: string | undefined;
  let dismissedQuery: string | undefined;
  let unseen = false;
  let lastTail = "";
  let interactionNotice = "";
  let interactionNoticeUntil = 0;
  let interactionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let paintedCancellationId: number | undefined;
  type DraftStatus = "empty" | "dirty" | "saved" | "restore-pending" | "restored" | "save-failed" | "cleanup-failed" | "unavailable";
  type DraftState = { store?: DraftStore; target: ReturnType<TuiController["draftCheckpointTarget"]>; text: string; revision: number; dirty: boolean; suppressed: boolean; status: DraftStatus; timer?: ReturnType<typeof setTimeout> };
  const durableDrafts = new Map<string, DraftState>();
  let durableDraft: DraftState | undefined;
  let draftFrozen = false;

  function draftResult(state = durableDraft): { saved: boolean; failed: boolean } {
    return {
      saved: !!state?.text && !state.dirty && state.store?.checkpoint?.text === state.text,
      failed: !!state && ["save-failed", "cleanup-failed", "unavailable"].includes(state.status),
    };
  }

  function draftNotice(state: DraftState | undefined, width: number): string {
    const message = state?.status === "saved" ? ["Draft saved", "Alt+D discard"]
      : state?.status === "restored" ? ["Draft restored", "Alt+D discard"]
      : state?.status === "save-failed" ? ["Draft not saved", "Select text, Ctrl+C copy"]
      : state?.status === "cleanup-failed" ? ["Draft cleanup failed", "Alt+D retry"]
      : state?.status === "unavailable" ? ["Draft recovery unavailable", "Enter start a task"] : undefined;
    if (!message) return "";
    const full = message.join(" · ");
    if (Bun.stringWidth(full) <= width) return full;
    const status = state?.status === "unavailable" ? "Draft unavailable" : message[0];
    const action = state?.status === "save-failed" && Bun.stringWidth(message[1]!) > width ? "Select, Ctrl+C copy" : message[1];
    return `${status}\n${action}`;
  }

  function checkpointDraft(state = durableDraft): void {
    if (!state) return;
    clearTimeout(state.timer); state.timer = undefined;
    if (!state.dirty || state.suppressed || !state.store) return;
    try {
      if (!isOrdinaryDraft(state.text, false, options.secrets)) return;
      if (state.text) state.target.ensurePersisted();
      if (state.store.save(state.text, ++state.revision)) {
        state.dirty = false;
        state.status = state.text ? "saved" : "empty";
      } else state.status = state.text ? "save-failed" : "cleanup-failed";
    } catch { state.status = state.text ? "save-failed" : "cleanup-failed"; }
  }

  function observeDraft(text: string, suppressed: boolean): void {
    const state = durableDraft;
    if (!state || draftFrozen) return;
    if (suppressed || text.trimStart().startsWith("/") || !isOrdinaryDraft(text, false, options.secrets)) {
      clearTimeout(state.timer); state.timer = undefined; state.suppressed = true; return;
    }
    state.suppressed = false;
    if (state.text !== text) { state.text = text; state.dirty = true; state.status = state.store ? "dirty" : "unavailable"; clearTimeout(state.timer); state.timer = undefined; }
    if (state.dirty && !state.timer) state.timer = setTimeout(() => { checkpointDraft(state); refresh(); }, 500);
  }

  function clearDurableDraft(state = durableDraft): boolean {
    if (!state) return true;
    if (!state.store) { state.status = "unavailable"; return false; }
    clearTimeout(state.timer); state.timer = undefined;
    try {
      if (state.store.clear(++state.revision)) { state.dirty = false; state.text = ""; state.status = "empty"; return true; }
    } catch { /* Keep the current draft and its write intent when cleanup is unconfirmed. */ }
    state.status = "cleanup-failed"; return false;
  }

  // Zones: top bar (surface) · canvas (background) · raised composer · status bar (surface) · key hints.
  const root = new BoxRenderable(renderer, { id: "conversation", width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.background });
  renderer.root.add(root);
  const topBar = new BoxRenderable(renderer, { id: "top-bar", height: 1, flexShrink: 0, flexDirection: "row", paddingX: 1, backgroundColor: theme.surface });
  root.add(topBar);
  const header = new TextRenderable(renderer, { id: "header", height: 1, flexGrow: 1, flexShrink: 1, wrapMode: "none" });
  topBar.add(header);
  const body = new BoxRenderable(renderer, { id: "body", flexDirection: "column", flexBasis: 0, flexGrow: 1, minHeight: 1, paddingX: 2, marginTop: 1 });
  root.add(body);
  const returnContext = new TextRenderable(renderer, { id: "return-context", flexShrink: 0, fg: theme.muted, wrapMode: "word", visible: false });
  body.add(returnContext);
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript", flexBasis: 0, flexGrow: 1, minHeight: 1, stickyScroll: true, stickyStart: "bottom", scrollX: false,
    contentOptions: { flexDirection: "column", paddingRight: 1 },
    verticalScrollbarOptions: { visible: false },
  });
  // ScrollBar initializes automatic visibility after its constructor options.
  // Set the override afterwards so overflow never changes the text's width.
  transcript.verticalScrollBar.visible = false;
  body.add(transcript);
  const empty = new TextRenderable(renderer, { id: "empty-conversation", content: "Start a task · / browse commands", fg: theme.muted, marginTop: 1 });
  transcript.add(empty);
  const taskExamples = new TextRenderable(renderer, { id: "task-examples", content: "", fg: theme.muted, marginTop: 1, wrapMode: "none", visible: false });
  transcript.add(taskExamples);
  const readerPanel = new BoxRenderable(renderer, { id: "reader-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, flexDirection: "column", overflow: "hidden" });
  const readerText = new TextRenderable(renderer, { id: "reader-text", content: "", fg: theme.text, wrapMode: "none", flexShrink: 0 });
  readerPanel.add(readerText);
  body.add(readerPanel);
  const tree = new ScrollBoxRenderable(renderer, { id: "branch-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, scrollX: false, contentOptions: { flexDirection: "column" } });
  body.add(tree);
  const preferencePanel = new ScrollBoxRenderable(renderer, { id: "preferences-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, scrollX: false, contentOptions: { flexDirection: "column" } });
  body.add(preferencePanel);
  const reviewPanel = new BoxRenderable(renderer, { id: "change-review-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, flexDirection: "column" });
  const reviewHeading = new TextRenderable(renderer, { id: "change-review-heading", content: "", fg: theme.text, flexShrink: 0, marginBottom: 1 });
  const reviewColumns = new BoxRenderable(renderer, { id: "change-review-columns", flexGrow: 1, minHeight: 0, flexDirection: "row" });
  // Scope labels sit outside the scroll boxes so turn evidence and current content stay named while scrolling.
  const reviewFilesColumn = new BoxRenderable(renderer, { id: "change-review-files-column", flexShrink: 0, flexDirection: "column" });
  const reviewFilesTitle = new TextRenderable(renderer, { id: "change-review-files-label", content: "", fg: theme.text, flexShrink: 0, wrapMode: "none", visible: false });
  const reviewDiffColumn = new BoxRenderable(renderer, { id: "change-review-diff-column", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" });
  const reviewDiffTitle = new TextRenderable(renderer, { id: "change-review-diff-label", content: "", fg: theme.text, flexShrink: 0, wrapMode: "none", visible: false });
  const reviewFiles = new ScrollBoxRenderable(renderer, { id: "change-review-files", width: 20, flexShrink: 0, scrollX: false });
  const reviewList = new TextRenderable(renderer, { id: "change-review-list", content: "", fg: theme.text, wrapMode: "none" });
  const reviewDivider = new TextRenderable(renderer, { id: "change-review-divider", width: 3, flexShrink: 0, content: "", fg: theme.border });
  // Reserve the scrollbar column so its thumb never covers the last character of a diff or Details line.
  const reviewDiff = new ScrollBoxRenderable(renderer, { id: "change-review-diff", flexGrow: 1, minHeight: 1, minWidth: 0, scrollX: false, contentOptions: { paddingRight: 1 } });
  const reviewText = new TextRenderable(renderer, { id: "change-review-text", content: "", fg: theme.text, wrapMode: "word" });
  reviewFiles.add(reviewList);
  reviewFiles.verticalScrollBar.visible = false;
  reviewDiff.add(reviewText);
  reviewFilesColumn.add(reviewFilesTitle);
  reviewFilesColumn.add(reviewFiles);
  reviewDiffColumn.add(reviewDiffTitle);
  reviewDiffColumn.add(reviewDiff);
  reviewColumns.add(reviewFilesColumn);
  reviewColumns.add(reviewDivider);
  reviewColumns.add(reviewDiffColumn);
  reviewPanel.add(reviewHeading);
  reviewPanel.add(reviewColumns);
  body.add(reviewPanel);
  const historyPanel = createHistoryPanel(renderer);
  body.add(historyPanel.root);
  const toolApprovalPanel = new BoxRenderable(renderer, { id: "tool-approval-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, flexDirection: "column", backgroundColor: theme.surface2, paddingX: 1, overflow: "hidden" });
  const toolApprovalHeading = new TextRenderable(renderer, { id: "tool-approval-heading", content: "", fg: theme.text, flexShrink: 0, wrapMode: "word", marginBottom: 1 });
  const toolApprovalScroll = new ScrollBoxRenderable(renderer, { id: "tool-approval-scroll", flexGrow: 1, minHeight: 1, scrollX: false });
  const toolApprovalText = new TextRenderable(renderer, { id: "tool-approval-text", content: "", fg: theme.text, wrapMode: "char" });
  const toolApprovalChoices = new TextRenderable(renderer, { id: "tool-approval-choices", content: "", fg: theme.text, flexShrink: 0, wrapMode: "word", marginTop: 1 });
  toolApprovalScroll.add(toolApprovalText);
  toolApprovalPanel.add(toolApprovalHeading);
  toolApprovalPanel.add(toolApprovalScroll);
  toolApprovalPanel.add(toolApprovalChoices);
  body.add(toolApprovalPanel);
  let toolApprovalIdentity = "";
  let toolApprovalContent = "";
  // The approval rows planned this refresh, and a measured correction keyed by the estimate it replaced.
  let toolApprovalLayout: ApprovalPanelLayout | undefined;
  let toolApprovalRows: { estimate: number; rows: number } | undefined;
  const activity = new TextRenderable(renderer, { id: "activity", height: 1, flexShrink: 0, fg: theme.muted, marginTop: 1 });
  body.add(activity);
  const picker = new BoxRenderable(renderer, { id: "picker", flexDirection: "column", flexShrink: 0, backgroundColor: theme.surface2, paddingX: 1, overflow: "hidden", visible: false });
  body.add(picker);
  // Half-block caps give the composer a raised block without spending rows on rules.
  const composerTop = new TextRenderable(renderer, { id: "composer-top", height: 1, flexShrink: 0, fg: theme.surface, wrapMode: "none" });
  body.add(composerTop);
  const composer = new BoxRenderable(renderer, { id: "composer", flexDirection: "row", flexShrink: 0, backgroundColor: theme.surface });
  body.add(composer);
  const focusBar = new TextRenderable(renderer, { content: "▌", fg: theme.accent, width: 1, flexShrink: 0 });
  composer.add(focusBar);
  const promptMark = new TextRenderable(renderer, { content: " › ", fg: theme.accent, width: 3, flexShrink: 0 });
  composer.add(promptMark);
  const editor = new TextareaRenderable(renderer, {
    id: "prompt", flexGrow: 1, minHeight: 1, maxHeight: 6, wrapMode: "word",
    placeholder: "Ask Schway…", textColor: theme.text, focusedTextColor: theme.text,
    backgroundColor: theme.surface, focusedBackgroundColor: theme.surface,
    placeholderColor: theme.muted, cursorColor: theme.accent, selectionBg: theme.border,
    keyBindings: [
      { name: "return", action: "submit" }, { name: "kpenter", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "j", ctrl: true, action: "newline" }, { name: "linefeed", action: "newline" },
    ],
  });
  composer.add(editor);
  const credential = new TextRenderable(renderer, { id: "credential", visible: false, fg: theme.text, flexGrow: 1, minWidth: 1 });
  composer.add(credential);
  const composerBottom = new TextRenderable(renderer, { id: "composer-bottom", height: 1, flexShrink: 0, fg: theme.surface, wrapMode: "none" });
  body.add(composerBottom);
  const footer = new TextRenderable(renderer, { id: "footer", height: 1, flexShrink: 0, fg: theme.muted, bg: theme.surface, wrapMode: "none" });
  root.add(footer);
  // Text renderables do not pad their own content, so the hint rows share a padded box with the body.
  const hintBar = new BoxRenderable(renderer, { id: "hint-bar", flexDirection: "column", flexShrink: 0, paddingX: 2 });
  root.add(hintBar);
  const hints = new TextRenderable(renderer, { id: "hints", height: 1, flexShrink: 0, fg: theme.muted, wrapMode: "none" });
  hintBar.add(hints);
  const draftStatus = new TextRenderable(renderer, { id: "draft-status", height: 1, flexShrink: 0, fg: theme.muted, wrapMode: "none", visible: false });
  hintBar.add(draftStatus);

  // Animated chrome is painted from these refresh-computed inputs on every tick.
  let pill: { label: string; tone: StatusTone; spinning: boolean } = { label: "READY", tone: "ready", spinning: false };
  let pillFrom = theme.surface2;
  let pillChangedAt = -Infinity;
  let footerParts: { approvalMode: TuiSnapshot["approvalMode"]; model: string; thinking?: string; route: string; ctx: string; ctxPercent?: number; running: boolean; nextAction: string; toolApproval?: boolean; notConnected?: boolean; override?: string } = { approvalMode: "auto", model: "", route: "", ctx: "", running: false, nextAction: "Enter send" };
  type ActivityPaint = { text: string; tone: "muted" | "accent" | "warning" | "error" | "success"; glyph?: string; spin?: boolean; chips?: boolean; outcome?: boolean };
  let activityPaint: ActivityPaint = { text: "", tone: "muted" };
  let pickerOpenedAt: number | undefined;
  let rowsAnimating = false;
  let splash: SplashRenderable | undefined;
  const fullSplash = options.splash === "full" && motion === "full" && renderer.width >= SPLASH_MIN_SIZE.width && renderer.height >= SPLASH_MIN_SIZE.height;
  let accentPending = motion === "full" && (options.splash === "accent" || options.splash === "full" && !fullSplash);
  let accentStartedAt: number | undefined;
  let headerPath = "", headerBranch = "";
  let gitHead: { root: string; at: number; value?: string } | undefined;
  let pickerWasVisible = false;
  let bodyPadding = 2;

  // Like a primary ScrollView, non-scrollable chrome routes wheel input to the
  // conversation. Preserve native handling over a scroller or multiline editor.
  root.onMouseScroll = event => {
    if (reader?.layout && (event.scroll?.direction === "up" || event.scroll?.direction === "down")) {
      const state = reader, layout = reader.layout;
      state.position = scrollReader(state.document, layout, state.position, event.scroll.direction === "up" ? -3 : 3);
      event.stopPropagation(); refresh(); return;
    }
    for (let target = event.target; target && target !== root; target = target.parent) {
      if (target instanceof ScrollBoxRenderable || target === editor) return;
    }
    event.stopPropagation();
    (controller.snapshot().history ? historyPanel.scroll : controller.snapshot().undoPreview || controller.snapshot().changeReview ? reviewPanel : controller.snapshot().preferences ? preferencePanel : controller.snapshot().branchTree ? tree : transcript).processMouseEvent(event);
  };

  const showInteractionNotice = (text: string) => {
    interactionNotice = text;
    interactionNoticeUntil = Date.now() + 2500;
    // Repaint when the notice expires so it does not linger until the next unrelated event.
    clearTimeout(interactionNoticeTimer);
    interactionNoticeTimer = setTimeout(() => { if (!destroyed) refresh(); }, 2510);
    refresh();
  };
  /** A notice from a layer that just closed names keys that no longer apply, so it ends with the layer. */
  const clearInteractionNotice = () => { interactionNoticeUntil = 0; clearTimeout(interactionNoticeTimer); };
  const copySelection = () => {
    if (controller.snapshot().credentialEntry) return false;
    const text = renderer.getSelection()?.getSelectedText();
    if (!text) return false;
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(safe(text)); } catch { /* Clipboard support is optional. */ }
    showInteractionNotice(copied ? "Copied selection" : "Clipboard unavailable · use the terminal's native selection");
    return true;
  };
  const inspectionTargets = (entries: readonly TuiTranscriptEntry[]): InspectionTarget[] => entries.flatMap<InspectionTarget>(entry => {
    if (entry.kind === "tool") return [{ id: entry.id, kind: "tool", index: 0, callId: entry.toolCallId, name: entry.toolName }];
    if (entry.kind !== "assistant") return [];
    // Code keeps its own ordinal; tables use a separate ordinal and are offered only with a proven source span.
    const blocks = (rows.get(entry.id)?.readableBlocks() ?? []).filter(block => block.text !== undefined);
    if (!blocks.length) return [];
    const source = safe(entry.text);
    return blocks.map(block => ({ id: entry.id, kind: block.kind, index: block.index, source, text: block.text!, title: block.title }));
  });
  const sameInspection = (left: InspectionTarget, right: InspectionTarget) => left.id === right.id && left.kind === right.kind && left.index === right.index;
  const inspectionNode = (target: InspectionTarget) => target.kind === "tool" ? rows.get(target.id)?.root : rows.get(target.id)?.root.findDescendantById(`${target.kind}-${target.id}-${target.index}`);
  const blockText = (target: InspectionTarget) => target.kind === "tool" ? undefined
    : target.kind === "code" ? rows.get(target.id)?.codeBlocks()[target.index]?.text
    : rows.get(target.id)?.readableBlocks().find(block => block.kind === "table" && block.index === target.index)?.text;
  const inspectionEntry = (target: InspectionTarget, entries: readonly TuiTranscriptEntry[]) => {
    const entry = entries.find(item => item.id === target.id);
    if (target.kind === "tool") return entry?.kind === "tool" && entry.toolCallId === target.callId && entry.toolName === target.name ? entry : undefined;
    // Ordinals are stable while Markdown appends, but can identify a different
    // block after replacement. Retain the source witness across renderer reparses.
    return entry?.kind === "assistant" && safe(entry.text).startsWith(target.source) ? entry : undefined;
  };
  const validInspection = (target: InspectionTarget, entries: readonly TuiTranscriptEntry[]) => !!inspectionEntry(target, entries) &&
    (target.kind === "tool" || !!blockText(target)?.startsWith(target.text));
  const clearInspection = () => {
    inspection = undefined; renderedInspection = undefined; paintedInspection = undefined; scrollToInspection = false;
    if (!panelMode) editor.focus();
  };
  const initialInspection = (entries: readonly TuiTranscriptEntry[]) => {
    const targets = inspectionTargets(entries);
    const previous = previousInspection && validInspection(previousInspection, entries) && targets.find(target => sameInspection(target, previousInspection!));
    if (previous) return previous;
    const top = transcript.viewport.y, bottom = top + transcript.viewport.height;
    let nearest: InspectionTarget | undefined, distance = Infinity;
    for (const target of targets) {
      const node = inspectionNode(target);
      if (!node?.visible || !node.height) continue;
      if (node.y < bottom && node.y + node.height > top) return target;
      const gap = node.y >= bottom ? node.y - bottom : top - node.y - node.height;
      if (gap < distance) { nearest = target; distance = gap; }
    }
    return nearest;
  };
  const inspectionText = (target: InspectionTarget, entries: readonly TuiTranscriptEntry[]) => {
    const entry = entries.find(item => item.id === target.id);
    return entry ? target.kind === "tool" ? safe(entry.text) : blockText(target) : undefined;
  };
  const inspectionVisible = (target: InspectionTarget) => {
    const node = inspectionNode(target);
    // The focus marker lives in the header; seeing only a long block's tail is insufficient.
    return !!node?.visible && !!node.height && transcript.visible && !panelMode && node.y >= transcript.viewport.y && node.y < transcript.viewport.y + transcript.viewport.height;
  };
  const externalPanelFor = (snapshot: TuiSnapshot): PanelMode | "" => snapshot.endpointUrlEntry ? "endpoint" : snapshot.credentialEntry ? "credential" : snapshot.loginCallbackEntry ? "callback" : snapshot.loginChooser ? "login" : snapshot.loginApproval ? "approval" : snapshot.sessionPicker ? "sessions" : snapshot.modelPicker ? "model" : snapshot.preferences ? "preferences" : snapshot.branchTree ? "tree" : snapshot.history ? "history" : snapshot.undoPreview ? "undo" : snapshot.changeReview ? "review" : "";
  /** Return the selected item's text only when its current highlight was painted; otherwise ask for the action again. */
  const verifiedInspection = (snapshot: TuiSnapshot, again: string): string | undefined => {
    if (!inspection) return;
    const entries = snapshot.transcript;
    if (sessionKey !== `${snapshot.sessionId}/${snapshot.branchId}` || externalPanelFor(snapshot) || !validInspection(inspection, entries)) {
      previousInspection = undefined;
      clearInspection();
      showInteractionNotice("Selection changed · Alt+I inspect again");
      return;
    }
    const text = inspectionText(inspection, entries);
    if (text === undefined) return;
    const painted = paintedInspection, node = inspectionNode(inspection);
    if (!painted || painted.target !== inspection || painted.text !== text || painted.node !== node || painted.y !== node?.y ||
        inspection.kind !== "tool" && painted.source !== safe(entries.find(entry => entry.id === inspection!.id)!.text) ||
        painted.scroll !== transcript.scrollTop || painted.width !== renderer.width || painted.height !== renderer.height || !inspectionVisible(inspection)) {
      paintedInspection = undefined;
      scrollToInspection = true;
      showInteractionNotice(again);
      return;
    }
    return text;
  };
  const copyInspection = (snapshot: TuiSnapshot) => {
    const text = verifiedInspection(snapshot, "Showing selection · C copy again");
    if (text === undefined || !inspection) return;
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(text); } catch { /* Clipboard support is optional. */ }
    const bounded = inspection.kind === "tool" && text.endsWith("… truncated. Full output is in the session file.");
    showInteractionNotice(copied ? bounded ? "Copied bounded result preview · full output is in the session file" : inspection.kind === "tool" ? "Copied displayed result" : inspection.kind === "table" ? "Copied table source · Esc back" : "Copied code · Esc back" : "Clipboard unavailable · select text in the terminal");
  };
  /** Open a fresh snapshot of the painted code/table target, or restore the checkpoint kept for an approval. */
  const openReader = (snapshot: TuiSnapshot) => {
    if (!inspection || inspection.kind === "tool") return;
    const text = verifiedInspection(snapshot, "Showing selection · R read again");
    const target = inspection as InspectionTarget | undefined;
    if (text === undefined || !target || target.kind === "tool") return;
    const saved = readerReturn;
    readerReturn = undefined;
    if (saved && saved.key === sessionKey && sameInspection(saved.target, target) && validInspection(saved.target, snapshot.transcript)) {
      reader = { ...saved, target, painted: false, scroll: transcript.scrollTop };
    } else {
      try {
        const document = createReaderDocument({ id: `${target.kind}-${target.id}-${target.index}`, messageId: target.id, kind: target.kind }, text,
          { title: fitLine(safe(target.title ?? target.kind), 24), streaming: target.id === snapshot.streamingAssistantId });
        reader = { document, target, key: sessionKey, position: { offset: 0, horizontal: 0 }, wrap: false, scroll: transcript.scrollTop, painted: false };
      } catch { showInteractionNotice("Reader unavailable · C copy"); return; }
    }
    transcript.stickyScroll = false;
    editor.blur();
  };
  /** Return to the same inspection target and reading position; the composer was never changed. */
  const closeReader = () => {
    if (!reader) return;
    searchRestoreScroll = reader.scroll;
    reader = undefined;
    clearInteractionNotice();
    if (inspection) editor.blur(); else editor.focus();
  };
  /** Hand input to a waiting approval, retaining one checkpoint for an explicit Alt+I then R return. */
  const suspendReader = () => {
    if (!reader) return;
    readerReturn = reader;
    searchRestoreScroll = reader.scroll;
    reader = undefined;
    clearInteractionNotice();
    if (inspection) { previousInspection = inspection; clearInspection(); }
  };
  const copyReader = () => {
    if (!reader) return;
    if (!reader.painted) { showInteractionNotice("Showing reader · C copy again"); return; }
    const { text, complete } = reader.document.copy.copy();
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(text); } catch { /* Clipboard support is optional. */ }
    showInteractionNotice(!copied ? "Clipboard unavailable · select text in the terminal" : !complete ? "Copied partial source · Esc back"
      : reader.document.kind === "table" ? "Copied table source · Esc back" : "Copied code · Esc back");
  };
  /** Rows available to the reader panel when it replaces the transcript and composer. */
  const readerRows = () => {
    if (readerMeasured && readerMeasured.width === renderer.width && readerMeasured.height === renderer.height) return readerMeasured.rows;
    return Math.max(1, renderer.height - (topBar.visible ? 1 : 0) - (typeof body.marginTop === "number" ? body.marginTop : 0)
      - (activity.visible ? 1 + (typeof activity.marginTop === "number" ? activity.marginTop : 0) : 0) - 1 - (hints.visible ? 1 : 0));
  };
  const onSelection = (selection: Selection) => {
    if (selection.isStart && selection.behavior === "cell") return;
    // Typing and selecting inside the editor must not overwrite the clipboard.
    if (selection.selectedRenderables.some(item => {
      for (let parent = item.parent; parent; parent = parent.parent) if (parent === transcript || parent === tree) return true;
      return false;
    })) copySelection();
  };
  const urlAt = (x: number, y: number, target: unknown) => {
    const buffer = renderer.currentRenderBuffer;
    if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return undefined;
    const id = getLinkId(buffer.buffers.attributes[y * buffer.width + x]!);
    return id ? browserUrl(buffer.lib.linkGetUrl(id, 16_384)) : target instanceof TextRenderable ? textLinkAt(target, x, y, renderer.widthMethod) : undefined;
  };
  let pressedLink: { x: number; y: number; url: string } | undefined;
  root.onMouseDown = event => {
    pressedLink = undefined;
    if (event.button !== 0 || controller.snapshot().credentialEntry) return;
    const url = urlAt(event.x, event.y, event.target);
    if (url) pressedLink = { x: event.x, y: event.y, url };
  };
  root.onMouseDrag = () => { pressedLink = undefined; };
  root.onMouseUp = event => {
    const pressed = pressedLink;
    pressedLink = undefined;
    if (!pressed || event.button !== 0 || event.x !== pressed.x || event.y !== pressed.y || urlAt(event.x, event.y, event.target) !== pressed.url) return;
    renderer.clearSelection();
    void options.openUrl?.(pressed.url).catch(() => showInteractionNotice("Could not open browser · copy the link to open it manually"));
  };

  const safe = (value: string) => displayText(redactSecrets(value, options.secrets));
  const clear = (box: BoxRenderable) => { for (const child of [...box.getChildren()]) child.destroyRecursively(); };
  const setDraft = (value: string) => { editor.setText(value); editor.gotoBufferEnd(); };
  const atBottom = () => transcript.scrollTop >= Math.max(0, transcript.scrollHeight - transcript.viewport.height) - 1;
  const latest = () => { transcript.stickyScroll = true; transcript.scrollTo(transcript.scrollHeight); unseen = false; };
  /** A panel, inspection, reader, search or details view owns the transcript position and pauses following. */
  const layered = () => !!panelMode || !!inspection || !!reader || searchOpen || !!detailsReturn;
  const textRow = (box: BoxRenderable, text: string, color = theme.text) => {
    const row = new TextRenderable(renderer, { content: safe(text), fg: color, flexShrink: 0, wrapMode: "word" });
    box.add(row);
    return row;
  };
  const resetRows = () => {
    for (const row of rows.values()) row.root.destroyRecursively();
    rows.clear();
  };

  function completions(): PaletteChoice[] {
    if (panelMode && panelMode !== "help" || editor.plainText === dismissedQuery) return [];
    if (panelMode === "help" && !helpInserted) return helpChoices();
    return controller.commandChoices(editor.plainText).map(entry => ({ ...entry, kind: "command" as const }));
  }

  /** Enter in the inline slash palette: insert the remembered highlight when it differs from the draft, else send. */
  function slashEnterAction(): SlashEnter {
    if (panelMode) return { kind: "send" };
    if (editor.plainText !== lastQuery) refresh();
    const choices = completions();
    const highlight = choices[completionIndex];
    return slashEnter(highlight?.id === completionId ? highlight : undefined, editor.plainText, { choices, chosen: completionChosen });
  }

  /** A known command followed by arguments, with no argument list to offer, has nothing left to browse. */
  function commandArguments(text: string): boolean {
    const name = /^\/(\S+)\s/.exec(text)?.[1];
    return !!name && !controller.commandChoices(text).length && controller.commandChoices(`/${name}`).some(entry => entry.name === name);
  }

  /** Searchable help rows; keyboard availability describes the composer this palette returns to. */
  function helpChoices(): PaletteChoice[] {
    const snapshot = controller.snapshot();
    const availability = keyboardGuideAvailability({
      running: controller.running || snapshot.status === "running", toolApproval: !!snapshot.toolApproval,
      inspectable: inspectionTargets(snapshot.transcript).length > 0,
      details: !!snapshot.noticeDetailsAvailable || !!snapshot.recovery?.actions.includes("details") || snapshot.outcome?.reason === "failed",
      blockedSubmit: blockedSubmitHint(snapshot),
    });
    return paletteChoices(controller.commandChoices("/"), availability, editor.plainText);
  }

  function paletteRows(choices: readonly PaletteChoice[]) {
    return paletteSections(choices, panelMode === "help" && !helpInserted ? !editor.plainText.trim() : editor.plainText === "/");
  }

  function keyboardRow(entry: KeyboardGuideChoice, selected: boolean, nameColumns: number, columns: number) {
    const parts = keyboardRowParts(entry, selected, nameColumns, columns);
    // Detail keeps its quieter or warning role but is re-measured on the selection fill it sits on.
    const detail = entry.available ? theme.muted : theme.warning;
    const row = new TextRenderable(renderer, { content: new StyledText([
      fg(selected ? theme.text : theme.muted)(parts.lead), fg(selected ? theme.text : entry.available ? theme.text : theme.muted)(parts.label),
      fg(selected ? textOn(detail, tint(theme, theme.accent)) : detail)(parts.detail),
    ]), flexShrink: 0, height: 1, wrapMode: "none" });
    if (selected) row.bg = tint(theme, theme.accent);
    picker.add(row);
  }

  function commandRow(entry: CommandChoice, selected: boolean, nameColumns: number, columns: number) {
    const color = selected ? theme.text : entry.destructive ? theme.warning : theme.muted;
    const prefix = `${selected ? "›" : " "} ${entry.available ? "  " : "! "}`;
    const name = fitLine(`/${safe(entry.name)}`, nameColumns);
    const label = name + " ".repeat(Math.max(0, nameColumns - Bun.stringWidth(name)) + 1);
    const remaining = Math.max(0, columns - Bun.stringWidth(prefix + label));
    const suffix = fitLine(entry.destructive ? " · deletes" : entry.provenance ? ` · ${safe(entry.provenance)}` : "", remaining);
    const description = fitLine(safe(entry.description), Math.max(0, remaining - Bun.stringWidth(suffix)));
    // Metadata keeps its quieter role but is re-measured on the selection fill it sits on.
    const metadata = entry.destructive ? mixColor(theme.warning, theme.muted, 0.5) : theme.muted;
    const suffixColor = selected ? textOn(metadata, tint(theme, theme.accent)) : metadata;
    const row = new TextRenderable(renderer, { content: new StyledText([
      fg(color)(prefix + label + description),
      fg(suffixColor)(suffix),
    ]), flexShrink: 0, height: 1, wrapMode: "none" });
    if (selected) row.bg = tint(theme, theme.accent);
    picker.add(row);
  }

  function refreshDiscovery() {
    // Explicit dispatch already refreshes metadata; its own repaint must not supersede it.
    if (pendingAcceptance) return;
    void controller.refreshCommands().then(() => { if (!destroyed) refresh(); }, () => {});
  }

  function applyTheme() {
    theme = resolveTheme(environmentMode ?? mode, renderer.themeMode, options.env);
    resetRows();
    clear(tree);
    clear(picker);
    syntax.destroy();
    syntax = markdownStyle(theme);
    root.backgroundColor = theme.background;
    renderer.setBackgroundColor(theme.background);
    picker.backgroundColor = theme.surface2;
    topBar.backgroundColor = composer.backgroundColor = footer.bg = theme.surface;
    composerTop.fg = composerBottom.fg = theme.surface;
    editor.textColor = editor.focusedTextColor = theme.text;
    editor.backgroundColor = editor.focusedBackgroundColor = theme.surface;
    editor.placeholderColor = theme.muted;
    editor.cursorColor = promptMark.fg = focusBar.fg = theme.accent;
    editor.selectionBg = theme.border;
    toolApprovalPanel.backgroundColor = theme.surface2;
    toolApprovalHeading.fg = toolApprovalText.fg = toolApprovalChoices.fg = theme.text;
    credential.fg = reviewText.fg = reviewList.fg = reviewHeading.fg = theme.text;
    reviewDivider.fg = theme.border;
    hints.fg = footer.fg = empty.fg = theme.muted;
    pillFrom = pillColors(pill.tone).bg;
    pillChangedAt = -Infinity;
    panelFingerprint = "";
    refresh();
  }

  /** Resolve theme background and foreground colors for each status tone. */
  function pillColors(tone: StatusTone): { bg: string; fg: string } {
    if (tone === "active") return { bg: theme.accent, fg: theme.onFill };
    if (tone === "stopping") return { bg: theme.warning, fg: theme.onFill };
    if (tone === "attention") return { bg: theme.error, fg: theme.onFill };
    if (tone === "neutral") return { bg: tint(theme, theme.muted, theme.surface), fg: textOn(theme.muted, tint(theme, theme.muted, theme.surface)) };
    return { bg: tint(theme, theme.success, theme.surface), fg: theme.success };
  }

  const chunkWidth = (chunks: readonly TextChunk[]) => chunks.reduce((sum, chunk) => sum + Bun.stringWidth(chunk.text), 0);
  const hintColors = (base: string) => ({ key: theme.text, chip: mixColor(base, theme.border, 0.9), action: theme.muted });

  /** The status bar already shows an Esc action (compact footer, hidden hint row, sign-in or running work). */
  const footerNamesEsc = () => footerParts.nextAction.startsWith("Esc") &&
    (renderer.width < 30 || !hints.visible || footerParts.override === undefined && (footerParts.notConnected || footerParts.running));

  /**
   * Key-chip hints that fit `columns`. Arrow and paging hints drop first, then trailing actions; primary actions
   * and disclosures such as `Tab more options` stay. The Esc way out stays last unless the footer already names one.
   * A row already written in priority order (the reader, where scrolling is the main action) drops from the end.
   */
  function fittedHints(text: string, columns: number, base = theme.background, ordered = false): StyledText {
    const segments = text.split(" · ");
    const escape = (segment: string) => segment === "Esc" || segment.startsWith("Esc ");
    const navigation = (segment: string) => /^(?:[↑↓←→]|PgUp|PgDn|PageUp|PageDown|Home|End)/.test(segment);
    const pinned = !footerNamesEsc();
    const fits = () => chunkWidth(keyHintChunks(segments.join(" · "), hintColors(base))) <= columns;
    const dropLast = (droppable: (segment: string) => boolean) => {
      const index = segments.findLastIndex(droppable);
      if (index < 0 || segments.length < 2) return false;
      segments.splice(index, 1);
      return true;
    };
    while (!ordered && !fits() && dropLast(navigation));
    while (!fits() && segments.filter(segment => !escape(segment)).length > 1 && dropLast(segment => !escape(segment) || !pinned));
    while (!fits() && !pinned && dropLast(escape));
    while (!fits() && dropLast(segment => !escape(segment)));
    const chunks = keyHintChunks(segments.join(" · "), hintColors(base));
    return new StyledText(chunkWidth(chunks) <= columns ? chunks : [fg(theme.muted)(fitLine(text, columns))]);
  }

  /** Render the status pill within terminal width, adding model details only after connection. */
  function paintFooter(at: number) {
    const columns = Math.max(1, renderer.width);
    const modeLabel = { auto: "Auto", ask: "Ask", "read-only": "Read-only" }[footerParts.approvalMode];
    const modeColor = footerParts.approvalMode === "auto" ? theme.text : theme.warning;
    const modeChip = [bold(fg(modeColor)(`◆ ${modeLabel}`)), fg(theme.muted)(" ")];
    // When space hides hints, keep the mode and urgent key before status decoration.
    const compactFooter = (action: string) => {
      const room = columns - Bun.stringWidth(modeLabel) - 4;
      // While a request waits, its whole action outranks the mode label: it is Enter's meaning in the approval panel (whose heading names ask mode)
      // or the only way back to the request from another view. When even the action alone is too wide, the panel keeps its last segment, Esc deny.
      if (footerParts.toolApproval && Bun.stringWidth(action) > room && Bun.stringWidth(action) <= columns - 2) { footer.content = new StyledText([fg(theme.muted)(` ${action}`)]); return; }
      const next = Bun.stringWidth(action) <= room ? action : footerParts.toolApproval ? action.split(" · ").at(-1)! : action.split(" ")[0]!;
      footer.content = new StyledText([fg(theme.muted)(" "), bold(fg(modeColor)(modeLabel)),
        ...(Bun.stringWidth(next) <= room ? [fg(theme.muted)(` · ${next}`)] : [])]);
    };
    if (columns < 30 || !hints.visible) { compactFooter(footerParts.nextAction); return; }
    if (footerParts.override !== undefined) { footer.content = new StyledText([fg(theme.muted)(" "), ...modeChip, fg(theme.muted)(fitLine(footerParts.override, columns - chunkWidth(modeChip) - 2))]); return; }
    const colors = pillColors(pill.tone);
    const fade = motion === "full" ? easeOut(progress(at, pillChangedAt, 180)) : 1;
    const fill = mixColor(pillFrom, colors.bg, fade);
    const glyph = pill.spinning ? spinnerFrame(at, motion) : pill.tone === "stopping" ? "◌" : pill.tone === "attention" ? "!" : pill.tone === "neutral" ? "○" : "●";
    const label = ` ${glyph} ${pill.label} `;
    const sweep = ((at / 30) % (label.length + 16)) - 8;
    // Fades and sweeps change the fill per cell, so each label cell is measured on its own composed fill.
    const pillChunks = [...label].map((char, index) => {
      const cell = pill.tone === "active" && motion === "full" ? mixColor(fill, theme.core, 0.28 * Math.exp(-((index - sweep) ** 2) / 6)) : fill;
      return bold(bg(cell)(fg(textOn(colors.fg, cell))(char)));
    });
    const approvalPillChunks = [...modeChip, ...pillChunks];
    if (footerParts.notConnected) {
      const action = keyHintChunks(footerParts.nextAction, hintColors(theme.surface));
      if (chunkWidth(approvalPillChunks) + chunkWidth(action) + 3 > columns) compactFooter(footerParts.nextAction);
      else footer.content = new StyledText([fg(theme.muted)(" "), ...approvalPillChunks, fg(theme.muted)(" "), ...action]);
      return;
    }
    const model = [bg(theme.surface2)(fg(theme.text)(` ${footerParts.model} `))];
    const thinking = footerParts.thinking ? [bg(tint(theme, theme.violet, theme.surface))(fg(theme.violet)(` ${footerParts.thinking} `))] : [];
    const route = footerParts.route ? [fg(theme.muted)(` ${footerParts.route}`)] : [];
    const cells = columns < 70 ? 5 : 10;
    const filled = footerParts.ctxPercent === undefined ? 0 : Math.max(footerParts.ctxPercent > 0 ? 1 : 0, Math.round(footerParts.ctxPercent / 100 * cells));
    const meterColor = (footerParts.ctxPercent ?? 0) < 60 ? theme.accent : (footerParts.ctxPercent ?? 0) < 85 ? theme.warning : theme.error;
    const ctx = footerParts.ctxPercent === undefined
      ? [fg(theme.muted)(`ctx ${footerParts.ctx}`)]
      : [fg(theme.muted)("ctx "), fg(meterColor)("━".repeat(filled)), fg(theme.border)("━".repeat(cells - filled)), fg(theme.muted)(` ${footerParts.ctxPercent}%`)];
    const esc = footerParts.running ? keyHintChunks(footerParts.nextAction, hintColors(theme.surface)) : [];
    const gapChunk = (size: number) => [fg(theme.muted)(" ".repeat(Math.max(1, size)))];
    // Keep mode and the active action; drop route, reasoning, model and context as space tightens.
    const include = { route: true, thinking: thinking.length > 0, ctx: true };
    const build = (modelChunks = model) => ({
      left: [...approvalPillChunks, fg(theme.muted)(" "), ...modelChunks, ...(include.thinking ? [fg(theme.muted)(" "), ...thinking] : []), ...(include.route ? route : [])],
      right: [...esc, ...(esc.length && include.ctx ? gapChunk(2) : []), ...(include.ctx ? ctx : [])],
    });
    let { left, right } = build();
    const fits = () => chunkWidth(left) + chunkWidth(right) + 3 <= columns;
    for (const key of ["route", "thinking"] as const) {
      if (fits()) break;
      include[key] = false;
      ({ left, right } = build());
    }
    for (const withContext of [true, false]) {
      if (fits()) break;
      include.ctx = withContext;
      const room = columns - chunkWidth(approvalPillChunks) - chunkWidth(build([]).right) - 6;
      ({ left, right } = build(room > 3 ? [bg(theme.surface2)(fg(theme.text)(` ${fitLine(footerParts.model, room - 2)} `))] : []));
    }
    if (!fits()) {
      if (chunkWidth(approvalPillChunks) + chunkWidth(esc) + 3 > columns) {
        compactFooter(footerParts.nextAction);
        return;
      }
      left = approvalPillChunks; right = esc;
    }
    footer.content = new StyledText([fg(theme.muted)(" "), ...left, ...gapChunk(columns - chunkWidth(left) - chunkWidth(right) - 2), ...right]);
  }

  /** Activity row above the composer: animated glyph, shimmering phase text, or a colored outcome with key chips. */
  function paintActivity(at: number) {
    const width = Math.max(1, renderer.width - 2 * bodyPadding);
    const paint = activityPaint;
    const color = theme[paint.tone === "muted" ? "muted" : paint.tone];
    const glyph = paint.spin ? spinnerFrame(at, motion) : paint.glyph;
    const lead = glyph ? [bold(fg(color)(glyph)), fg(theme.muted)(" ")] : [];
    // Work rows keep their Esc stop whole; status words give way first.
    const text = (paint.spin ? fitStatusAction : fitLine)(paint.text, width - (glyph ? 2 : 0));
    const labelEnd = text.indexOf(" · ");
    const chunks = paint.outcome ? [bold(fg(color)(labelEnd < 0 ? text : text.slice(0, labelEnd))), ...(labelEnd < 0 ? [] : keyHintChunks(text.slice(labelEnd), hintColors(theme.background)))]
      : paint.spin ? shimmer(text, at, theme.muted, theme.text, motion)
      : paint.chips ? keyHintChunks(text, hintColors(theme.background)) : [fg(paint.tone === "muted" ? theme.muted : color)(text)];
    activity.content = new StyledText([...lead, ...(chunkWidth(chunks) + (glyph ? 2 : 0) <= width ? chunks : [fg(color)(text)])]);
  }

  /** Paint cached header text while only the bolt changes during the startup accent. */
  function paintHeader(at: number) {
    const k = accentStartedAt === undefined ? 0 : progress(at, accentStartedAt, SPLASH_ACCENT_DURATION_MS);
    const bolt = accentPending || accentStartedAt !== undefined ? mixColor(theme.text, theme.bolt, k) : theme.bolt;
    header.content = new StyledText([
      bold(fg(bolt)("⚡")), fg(theme.text)(" "), bold(fg(theme.text)("schway")), fg(theme.muted)(headerPath ? `  ${headerPath}` : ""),
      ...(headerBranch ? [fg(theme.muted)(" on "), fg(theme.violet)(headerBranch)] : []),
    ]);
  }

  /** Advance decorative motion without recomputing the transcript model. */
  function animate() {
    if (destroyed) return;
    const at = now();
    if (splash && (splash.elapsed() >= SPLASH_DURATION_MS || renderer.width < SPLASH_MIN_SIZE.width || renderer.height < SPLASH_MIN_SIZE.height)) endSplash();
    if (accentStartedAt !== undefined && at - accentStartedAt >= SPLASH_ACCENT_DURATION_MS) accentStartedAt = undefined;
    paintHeader(at);
    paintFooter(at);
    paintActivity(at);
    rowsAnimating = false;
    for (const row of rows.values()) if (row.tick()) rowsAnimating = true;
    if (pickerOpenedAt !== undefined) {
      const natural = picker.getChildren().length;
      const k = easeOut(progress(at, pickerOpenedAt, 150));
      if (k >= 1) { picker.height = "auto"; pickerOpenedAt = undefined; }
      else picker.height = Math.max(1, Math.round(natural * k));
    }
    renderer.requestRender();
  }

  const ticker = createTicker(animate, () => !destroyed && motion !== "off" && (!!splash || accentPending || accentStartedAt !== undefined || pill.spinning || rowsAnimating || pickerOpenedAt !== undefined || now() - pillChangedAt < 200));

  function endSplash() {
    if (!splash) return;
    const painted = splash.hasPainted();
    splash.destroyRecursively();
    splash = undefined;
    if (painted) options.onSplashPlayed?.();
    editor.showCursor = true;
    renderer.dropLive();
  }

  // Task examples are static decoration below readiness: they only use rows the
  // empty conversation leaves free above the composer and never touch the editor.
  function paintTaskExamples(snapshot: TuiSnapshot, path: string, connection: string, route: string, action: string, width: number, draftRows: number) {
    const eligible = transcript.visible && taskExamplesEligible(snapshot, { draft: editor.plainText,
      owned: !!panelMode || !!inspection || !!detailsReturn, draftNotice: draftRows > 0 });
    const lineWidth = width - 1;
    const rowsFor = (text: string) => { const cells = Bun.stringWidth(text); return cells <= lineWidth ? 1 : Math.ceil(cells / lineWidth) + 1; };
    const margin = (value: number | string) => typeof value === "number" ? value : 0;
    const readinessRows = margin(empty.marginTop) + (topBar.visible ? 0 : rowsFor(safe(path))) + rowsFor(safe(`${connection} · ${route}`)) + 1 + rowsFor(action);
    // One-row chrome: top bar, activity, composer caps around one empty editor row, footer, hints and draft status.
    const transcriptRows = renderer.height - (topBar.visible ? 1 : 0) - margin(body.marginTop) - (activity.visible ? 1 + margin(activity.marginTop) : 0)
      - 3 - 1 - (hints.visible ? 1 : 0) - draftRows;
    const lines = eligible ? taskExampleLines(lineWidth, transcriptRows - readinessRows) : [];
    taskExamples.visible = lines.length > 0;
    taskExamples.content = new StyledText(lines.map((line, index) => fg(theme.muted)(`${index ? "\n" : ""}${line}`)));
  }

  function refresh() {
    if (destroyed || refreshing) return;
    refreshing = true;
    try {
      const currentConfiguredMode = controller.appearanceMode();
      if (configuredMode !== currentConfiguredMode) {
        configuredMode = currentConfiguredMode;
        mode = currentConfiguredMode;
        applyTheme();
      }
      const snapshot = controller.snapshot();
      // Startup readiness is transient chrome; recovery details remain available on demand.
      const entries = snapshot.readiness !== "ready" && snapshot.transcript.length === 1 && !snapshot.recovery?.accepted && snapshot.transcript[0]?.id === snapshot.recovery?.entryId ? [] : snapshot.transcript;
      paintedCancellationId = snapshot.activity?.cancellation === "requested" ? snapshot.activity.operationId : undefined;
      const width = Math.max(8, renderer.width - (renderer.width < 60 ? 2 : 4));
      bodyPadding = renderer.width < 60 ? 1 : 2;
      body.paddingX = hintBar.paddingX = bodyPadding;
      composerTop.content = "▄".repeat(width);
      composerBottom.content = "▀".repeat(width);
      topBar.visible = activity.visible = renderer.height >= 10;
      const context = snapshot.context;
      hints.visible = renderer.height >= 14 || !!snapshot.branchTree;
      body.marginTop = topBar.visible && renderer.height >= 20 ? 1 : 0;
      activity.marginTop = renderer.height >= 20 ? 1 : 0;
      const key = `${snapshot.sessionId}/${snapshot.branchId}`;
      const sessionChanged = !!activeSessionId && activeSessionId !== snapshot.sessionId;
      let recoveredText: string | undefined;
      if (options.draftPersistence && (!durableDraft || durableDraft.target.sessionId !== snapshot.sessionId)) {
        checkpointDraft();
        const target = controller.draftCheckpointTarget();
        const identity = `${target.workspaceRoot ?? options.workspaceRoot}/${target.sessionId}`;
        durableDraft = durableDrafts.get(identity);
        if (!durableDraft) {
          durableDraft = { target, text: "", revision: 0, dirty: false, suppressed: false, status: "empty" };
          durableDrafts.set(identity, durableDraft);
          try {
            durableDraft.store = openDraftStore({ home: options.home, workspaceRoot: target.workspaceRoot ?? options.workspaceRoot, sessionId: target.sessionId });
            const recovered = durableDraft.store.checkpoint;
            if (recovered) { durableDraft.text = recovered.text; recoveredText = recovered.text; durableDraft.status = "restore-pending"; }
          } catch { durableDraft.status = "unavailable"; }
        } else recoveredText = durableDraft.text;
      }
      let destination: { draft: string; cursor: number; scroll: number } | undefined;
      if (sessionChanged) {
        const draft = panelMode ? savedDraft : editor.plainText;
        // Ordinary drafts stay local to their conversation; commands and credential surfaces are never cached.
        sessionViewState.set(activeSessionId, { draft: draft.trimStart().startsWith("/") ? "" : draft,
          cursor: panelMode ? savedDraftCursor : editor.cursorOffset,
          scroll: panelMode === "sessions" ? sessionOriginalScroll : transcript.scrollTop });
        destination = sessionViewState.get(snapshot.sessionId);
        savedDraft = destination?.draft ?? recoveredText ?? "";
        savedDraftCursor = destination?.cursor ?? 0;
        savedDraftSelection = null;
        sessionOriginalScroll = destination?.scroll ?? 0;
      }
      activeSessionId = snapshot.sessionId;
      if (sessionKey !== key) {
        discoveryOpen = false; completionId = undefined;
        resetRows(); sessionKey = key; expandedTools.clear(); clearInspection(); previousInspection = undefined; unseen = false; lastTail = "";
        reader = undefined; readerReturn = undefined;
        detailsReturn = undefined; scrollToDetails = false; reviewDetailsScroll = undefined; reviewRestoreScroll = undefined;
        searchOpen = false; searchSelected = -1; searchLastQuery = "";
        searchRestoreScroll = undefined; searchScrollToMatch = false; searchAcceptPending = false;
        searchIndex.clear();
        latest();
        if (sessionChanged && destination) { searchRestoreScroll = destination.scroll; transcript.stickyScroll = false; restoreFollow = false; }
      }
      const externalPanel = externalPanelFor(snapshot);
      if (detailsReturn && (externalPanel || searchOpen || controller.commandHelpOpen || controller.running || !snapshot.transcript.some(entry => entry.id === detailsReturn!.entryId))) {
        detailsReturn = undefined; scrollToDetails = false;
      }
      if (externalPanel && reader) reader = undefined;
      if (externalPanel && inspection) { previousInspection = inspection; clearInspection(); }
      if (externalPanel || searchOpen) controller.commandHelpOpen = false;
      if (searchOpen && externalPanel) { searchOpen = false; searchScrollToMatch = false; searchAcceptPending = false; searchIndex.clear(); }
      const nextPanel: PanelMode | "" = externalPanel || (searchOpen ? "search" : controller.commandHelpOpen ? "help" : !inspection && !reader && snapshot.toolApproval ? "tool-approval" : "");
      if (nextPanel !== panelMode) {
        if (!panelMode && nextPanel) {
          if (!sessionChanged) {
            savedDraft = recoveredText ?? editor.plainText; savedDraftCursor = recoveredText === undefined ? editor.cursorOffset : 0;
            savedDraftSelection = recoveredText === undefined ? editor.getSelection() : null;
          }
          savedDraftRevision = editorRevision;
        }
        if (nextPanel === "sessions") { sessionOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (panelMode === "sessions" && !nextPanel && !sessionChanged) searchRestoreScroll = sessionOriginalScroll;
        if (nextPanel === "tree") { treeOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (panelMode === "tree" && !nextPanel && !sessionChanged) searchRestoreScroll = treeOriginalScroll;
        if (nextPanel === "review" || nextPanel === "undo") { reviewOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; reviewDetailsScroll = undefined; reviewRestoreScroll = undefined; }
        if ((panelMode === "review" || panelMode === "undo") && !nextPanel && !sessionChanged) searchRestoreScroll = reviewOriginalScroll;
        if (nextPanel === "history") { historyOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (panelMode === "history" && !nextPanel && !sessionChanged) searchRestoreScroll = historyOriginalScroll;
        if (nextPanel === "help") { helpInserted = false; lastQuery = undefined; helpOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (nextPanel !== "help") helpGuide = undefined;
        if (panelMode === "help" && !nextPanel && !sessionChanged) searchRestoreScroll = helpOriginalScroll;
        panelMode = nextPanel;
        setDraft(panelMode === "model" ? snapshot.modelPicker?.query ?? "" : panelMode ? "" : savedDraft);
        if (!panelMode) {
          editor.cursorOffset = savedDraftCursor;
          if (savedDraftSelection) editor.setSelection(savedDraftSelection.start, savedDraftSelection.end);
        }
        panelFingerprint = "";
      }
      if (sessionChanged && !nextPanel) { setDraft(savedDraft); editor.cursorOffset = savedDraftCursor; }
      if (!sessionChanged && recoveredText !== undefined && !nextPanel) setDraft(recoveredText);
      if (!nextPanel && durableDraft?.status === "restore-pending" && editor.plainText === durableDraft.text) durableDraft.status = "restored";
      const secretSurface = !!snapshot.endpointUrlEntry || !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval || !!snapshot.loginChooser;
      observeDraft(panelMode ? savedDraft : editor.plainText, secretSurface);
      const draftMessage = !panelMode && !reader && !durableDraft?.suppressed ? draftNotice(durableDraft, width) : "";
      draftStatus.visible = !!draftMessage;
      draftStatus.height = draftMessage.includes("\n") ? 2 : 1;
      draftStatus.content = draftMessage;
      editor.visible = (panelMode !== "tool-approval" || !!snapshot.toolApproval?.enteringReason) && !snapshot.undoPreview && !snapshot.changeReview && !snapshot.history && !snapshot.endpointUrlEntry && !snapshot.credentialEntry && !snapshot.loginCallbackEntry && !snapshot.loginApproval && !reader;
      // An open approval without reason entry takes the composer's rows for its choices.
      composerTop.visible = composer.visible = composerBottom.visible = !reader && (panelMode !== "tool-approval" || !!snapshot.toolApproval?.enteringReason);
      credential.visible = !!snapshot.endpointUrlEntry || !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval;
      if (snapshot.undoPreview || snapshot.changeReview || snapshot.history || panelMode === "tool-approval" && !snapshot.toolApproval?.enteringReason) { editor.blur(); }
      else if (snapshot.endpointUrlEntry || snapshot.credentialEntry || snapshot.loginCallbackEntry || snapshot.loginApproval) {
        editor.blur();
        credential.content = snapshot.endpointUrlEntry
          ? new StyledText([
            fg(snapshot.endpointUrlEntry.value ? theme.text : theme.muted)(safe(`Endpoint URL · ${snapshot.endpointUrlEntry.value || "http://localhost:8787"}`)),
            ...(snapshot.endpointUrlEntry.error ? [fg(theme.error)(safe(`\n${snapshot.endpointUrlEntry.error}`))] : []),
          ])
          : snapshot.credentialEntry
          ? safe(`API key · ${snapshot.credentialEntry.label}\n${snapshot.credentialEntry.masked || "Enter key…"}\nEnter save · Esc cancel`)
          : snapshot.loginCallbackEntry
            ? safe(`Browser callback · ${snapshot.loginCallbackEntry.masked || "Paste redirect URL or code…"} · Enter sign in · Esc cancel`)
            : "Approval pending · Esc cancels";
      } else if (reader) editor.blur();
      else if ((!inspection || searchOpen) && !editor.focused) editor.focus();
      editor.placeholder = panelMode === "tool-approval" ? "Why? The agent will see this…" : panelMode === "sessions" ? "Search tasks, workspace or session ID…" : panelMode === "model" ? "Search models or type provider/model…" : panelMode === "tree" ? snapshot.branchTree?.selectedBranchId ? "Continue · Tab: fork" : "Fork name…" : panelMode === "help" ? PALETTE_PLACEHOLDER : panelMode === "search" ? "Find in this conversation…" : snapshot.status === "running" ? runningPlaceholder(renderer.width) : "Ask Schway…";
      const workspace = controller.workspaceIdentity();
      const workspacePath = workspace?.root ?? options.workspaceRoot;
      const path = workspacePath === options.home || workspacePath.startsWith(`${options.home}/`) ? `~${workspacePath.slice(options.home.length)}` : workspacePath;
      const headRoot = workspace?.root ?? options.workspaceRoot;
      if (!gitHead || gitHead.root !== headRoot || Date.now() - gitHead.at > 2000) gitHead = { root: headRoot, at: Date.now(), value: readGitHead(headRoot) };
      const branchLabel = gitHead.value ? safe(gitHead.value) : "";
      const room = Math.max(0, renderer.width - 2 - Bun.stringWidth("⚡ schway  "));
      const final = safe(path).split("/").filter(Boolean).at(-1) ?? path;
      const shortest = shortenWorkspacePath(safe(workspacePath), options.home, Bun.stringWidth(`…/${final}`));
      const branchRoom = renderer.width >= 40 ? Math.max(0, room - Bun.stringWidth(shortest) - 4) : 0;
      // A shortened detached commit is an identity, not a label we can abbreviate again.
      const shortSha = /^[0-9a-f]{7}$/.test(branchLabel);
      headerBranch = branchRoom > 0 && (!shortSha || branchRoom >= 7) ? fitLine(branchLabel, branchRoom) : "";
      headerPath = shortenWorkspacePath(safe(workspacePath), options.home, room - (headerBranch ? Bun.stringWidth(headerBranch) + 4 : 0));
      paintHeader(now());
      const nextPill = statusPill(snapshot, width < 32);
      if (nextPill.tone !== pill.tone) { pillFrom = pillColors(pill.tone).bg; pillChangedAt = now(); }
      pill = nextPill;
      const ctxPercent = context.capacity ? Math.min(100, Math.round(context.estimatedTokens / context.capacity * 100)) : undefined;
      footerParts = {
        approvalMode: snapshot.approvalMode,
        model: snapshot.modelId ? safe(`${snapshot.provider}/${snapshot.modelId}`) : "", thinking: snapshot.modelId && snapshot.thinking ? safe(snapshot.thinking) : undefined,
        route: snapshot.modelId ? safe(`${snapshot.activeRoute ?? ""}${snapshot.profile ? `${snapshot.activeRoute ? " · " : ""}${snapshot.profile}` : ""}`) : "",
        ctx: `~${context.estimatedTokens}${context.summaryId ? " · summary" : ""}`, ctxPercent,
        running: !!snapshot.activity || snapshot.status === "running",
        toolApproval: !!snapshot.toolApproval,
        notConnected: snapshot.readiness === "not-connected",
        // Ctrl+C lives only in the approval activity row; the hint row carries Enter's meaning when it is visible.
        nextAction: panelMode === "tool-approval" && snapshot.toolApproval ? hints.visible && renderer.width >= 30 ? "Esc deny" : approvalAction(snapshot.toolApproval.selected, snapshot.toolApproval.enteringReason)
          // A request waiting behind another view: name Esc exactly as that view's hint row and reader status do.
          : snapshot.toolApproval ? "Esc back to request"
          : searchOpen || reader?.search ? "Esc restore" : panelMode === "undo" ? undoEscape(snapshot.undoPreview)
          : panelMode === "preferences" && snapshot.preferences ? preferenceEscape(snapshot.preferences) : panelMode === "credential" || panelMode === "callback" ? "Esc cancel" : panelMode || inspection || detailsReturn || reader ? "Esc back"
          : snapshot.activity || snapshot.status === "running" ? "Esc stop"
          : snapshot.readiness === "loading" ? "Esc cancel"
          : snapshot.recovery?.actions.includes("details") ? "F2 details"
          : blockedSubmitHint(snapshot) ? blockedSubmitHint(snapshot).split(" · ")[0]!
          : snapshot.readiness === "ready" ? "Enter send"
          : snapshot.readiness === "not-connected" || snapshot.readiness === "connect" ? "Alt+L sign in" : "Alt+M model",
      };
      const tail = entries.at(-1);
      const tailKey = `${tail?.id}:${tail?.text.length}:${tail?.toolStatus}`;
      if (resumeFollowTop !== undefined && (layered() || transcript.scrollTop !== resumeFollowTop)) resumeFollowTop = undefined;
      if (lastTail && lastTail !== tailKey && layered() && tail?.id !== detailsReturn?.entryId) grewWhileLayered = true;
      if (lastTail && lastTail !== tailKey && resumeFollowTop !== undefined) { resumeFollowTop = undefined; latest(); }
      else if (lastTail && lastTail !== tailKey && !atBottom()) unseen = true;
      lastTail = tailKey;
      if (atBottom()) unseen = false;
      transcript.visible = panelMode !== "tool-approval" && !snapshot.branchTree && !snapshot.preferences && !snapshot.changeReview && !snapshot.undoPreview && !snapshot.history && !reader;
      readerPanel.visible = !!reader;
      if (reader) {
        const panelRows = readerRows();
        reader.layout = readerLayout(reader.document, reader.wrap, width, panelRows, { approval: !!snapshot.toolApproval, search: !!reader.search });
        reader.position = readerBodyPosition(reader.document, reader.layout, reader.position);
        // A taller body (find row closed, terminal resized) still fills from the last full page, like End.
        const last = readerEnd(reader.document, reader.layout, reader.position.horizontal);
        if (last.offset < reader.position.offset) reader.position = { offset: last.offset, horizontal: reader.position.horizontal };
        readerText.content = paintReader({ document: reader.document, layout: reader.layout, position: reader.position, columns: width, rows: panelRows, theme, search: reader.search });
        readerText.height = panelRows;
      }
      toolApprovalPanel.visible = panelMode === "tool-approval";
      toolApprovalLayout = undefined;
      if (toolApprovalPanel.visible && snapshot.toolApproval) {
        const approval = snapshot.toolApproval;
        const identity = approval.request.toolCallId;
        if (identity !== toolApprovalIdentity) { toolApprovalIdentity = identity; toolApprovalScroll.scrollTo(0); }
        const counts = approval.diff ? `  +${approval.diff.added} −${approval.diff.removed}` : "";
        const target = approval.path ? `${shortenWorkspacePath(safe(approval.path), options.home, Math.max(1, width - 2 - Bun.stringWidth(counts)))}${counts}` : "";
        const content = JSON.stringify([identity, target, approval.content, approval.diff, mode]);
        if (content !== toolApprovalContent) {
          toolApprovalText.content = new StyledText([
            fg(theme.text)(safe(target || approval.content)),
            ...(approval.diff ? formatDiffRows(approval.diff.rows).split("\n").map((line, index) => fg(approval.diff!.rows[index]?.sign === "+" ? theme.success : theme.error)(`\n${safe(line)}`)) : []),
          ]);
          toolApprovalContent = content;
        }
        // Size the panel from the rows the chrome leaves; a measured panel height corrects the estimate (reason entry grows the editor).
        const margin = (value: number | string) => typeof value === "number" ? value : 0;
        const estimate = renderer.height - (topBar.visible ? 1 : 0) - margin(body.marginTop) - (activity.visible ? 1 + margin(activity.marginTop) : 0)
          - (composer.visible ? 2 + Math.max(1, editor.height) : 0) - 1 - (hints.visible ? 1 : 0) - (draftStatus.visible ? margin(draftStatus.height) : 0);
        const rows = toolApprovalRows?.estimate === estimate ? toolApprovalRows.rows : estimate;
        toolApprovalRows = { estimate, rows };
        const preview = [target || approval.content, ...(approval.diff ? formatDiffRows(approval.diff.rows).split("\n") : [])].join("\n");
        const plan = toolApprovalLayout = approvalPanelLayout({ heading: safe(`Allow ${approval.request.toolName}? · ask mode`), choices: approvalChoices(safe(approval.request.toolName)),
          selected: approval.selected, previewRows: charWrappedRows(safe(preview), width - 2), rows, columns: width - 2 });
        toolApprovalHeading.content = plan.heading;
        toolApprovalHeading.marginBottom = plan.headingMargin ? 1 : 0;
        toolApprovalChoices.marginTop = plan.choicesMargin ? 1 : 0;
        toolApprovalChoices.content = new StyledText(plan.choices.map((choice, index) => fg(choice.selected ? theme.accent : theme.text)(`${index ? "\n" : ""}${choice.text}`)));
      }
      reviewPanel.visible = !!snapshot.changeReview || !!snapshot.undoPreview;
      if (snapshot.changeReview || snapshot.undoPreview) {
        const undo = snapshot.undoPreview;
        const selected = undo?.files[undo.selected];
        const review = undo ? { heading: undoHeading(undo), selected: undo.selected,
          rows: undoRows(undo), showingDetails: false, details: "", detail: JSON.stringify(selected?.rows), files: [] } : snapshot.changeReview!;
        const stacked = !!undo || renderer.width < 80;
        const scope = undo ? undefined : snapshot.changeReview!.scope;
        // A review opened from the undo panel lists that panel's paths with current-diff titles but no turn source badges.
        const fromUndo = !undo && !!snapshot.changeReview!.fromUndo, titled = !!scope || fromUndo;
        const fileRows = undo ? undo.files.map(file => ({ path: safe(file.path), badge: safe(file.status) })) : review.files.map(file => ({ path: safe(file.path), badge: fromUndo ? "" : reviewFileBadge(file) }));
        const filesTitle = scope ? reviewFilesLabel(scope) : fromUndo ? UNDO_REVIEW_FILES : "";
        const longestFile = fileRows.reduce((longest, row) => Math.max(longest, Bun.stringWidth(`  ${row.path}${row.badge ? `  ${row.badge}` : ""}`)), Math.max(20, Bun.stringWidth(filesTitle)));
        const fileWidth = stacked ? width : Math.min(Math.floor(width * 0.4), longestFile);
        reviewHeading.content = safe(review.heading);
        reviewColumns.flexDirection = stacked ? "column" : "row";
        // Turn evidence keeps its own title and empty state; current content is titled by the path it was loaded for.
        reviewFilesTitle.visible = reviewDiffTitle.visible = titled;
        if (titled) {
          const currentPath = snapshot.changeReview!.currentPath;
          reviewFilesTitle.content = new StyledText([bold(fg(theme.accent)(fitLine(filesTitle, fileWidth)))]);
          const titleWidth = stacked ? width : Math.max(1, width - fileWidth - 3);
          // Truncate the path from the left so the file name stays visible beside the fixed label.
          const diffTitle = review.showingDetails ? scope ? reviewDetailsLabel(scope) : UNDO_REVIEW_DETAILS : currentPath === undefined ? currentDiffLabel()
            : currentDiffLabel(fitPathStart(safe(currentPath), titleWidth - Bun.stringWidth(currentDiffLabel(""))));
          reviewDiffTitle.content = new StyledText([bold(fg(theme.accent)(fitLine(diffTitle, titleWidth)))]);
          // The undo panel did list paths; an empty undo review means none were inside the workspace.
          if (!fileRows.length) fileRows.push({ path: fromUndo ? UNDO_REVIEW_NO_FILES : scope ? emptyFilesLabel(scope) : "None observed", badge: "" });
        }
        reviewFilesColumn.width = fileWidth;
        reviewFilesColumn.marginBottom = stacked && titled ? 1 : 0;
        reviewFiles.visible = fileRows.length > 0;
        reviewFiles.width = fileWidth;
        reviewFiles.height = stacked ? Math.min(fileRows.length, Math.max(1, Math.floor((renderer.height - 8) / 3))) : titled ? "auto" : "100%";
        reviewFiles.flexGrow = !stacked && titled ? 1 : 0;
        reviewFiles.marginBottom = stacked && fileRows.length && !titled ? 1 : 0;
        reviewList.content = fileRows.map((row, index) => {
          if (!review.files.length && titled) return `  ${fitLine(row.path, fileWidth - 2)}`;
          const fitRow = (text: string, columns: number) => titled ? fitPathStart(text, columns) : fitLine(text, columns);
          if (!row.badge) return `${index === review.selected ? "›" : " "} ${fitRow(row.path, fileWidth - 2)}`;
          const pathWidth = Math.max(1, fileWidth - 4 - Bun.stringWidth(row.badge));
          const path = fitRow(row.path, pathWidth);
          return `${index === review.selected ? "›" : " "} ${path}${" ".repeat(Math.max(0, pathWidth - Bun.stringWidth(path)))}  ${row.badge}`;
        }).join("\n");
        reviewFiles.scrollTo(Math.max(0, review.selected - Math.max(1, reviewFiles.height) + 1));
        reviewDivider.visible = !stacked && fileRows.length > 0;
        reviewDivider.content = Array.from({ length: renderer.height }, () => " │ ").join("\n");
        // Explanations without a file list wrap at words; diff rows wrap anywhere to keep line numbers aligned.
        reviewText.wrapMode = review.showingDetails || (!undo && !review.files.length) ? "word" : "char";
        const content = JSON.stringify([review.showingDetails, review.rows, review.detail, review.details, mode]);
        if (content !== reviewContent) {
          reviewText.content = review.showingDetails ? safe(review.details) : new StyledText(review.rows.map((row, index) => {
            const text = `${row.line === undefined ? "" : `${String(row.line).padStart(3)} ${undo ? "│" : ""}${row.sign}${undo ? "" : " "}`}${safe(row.text)}${index < review.rows.length - 1 ? "\n" : ""}`;
            if (row.comparison) return bold(fg(theme.accent)(text));
            return fg(row.sign === "+" ? theme.success : row.sign === "-" ? theme.error : theme.text)(text);
          }));
          reviewContent = content;
        }
      }
      historyPanel.paint(snapshot.history, width, theme, safe);
      preferencePanel.visible = !!snapshot.preferences;
      tree.visible = !!snapshot.branchTree;
      empty.visible = entries.length === 0;
      const route = snapshot.modelId ? snapshot.activeRoute ?? (snapshot.provider === "openai-compatible" ? `Compatible endpoint${snapshot.profile ? ` · profile:${snapshot.profile}` : ""}` : `${snapshot.provider} API key`) : "";
      const connection = snapshot.modelId ? `${snapshot.provider}/${snapshot.modelId}` : "No model yet";
      returnContext.visible = !panelMode && !reader && (!!snapshot.recentSession || !!snapshot.restored);
      returnContext.content = (safe(snapshot.recentSession
        ? `New conversation · Alt+B resume: ${snapshot.recentSession.title}\n${snapshot.recentSession.previewIncomplete ? "Resume saved work · Alt+B resume · /sessions browse" : "/sessions for all history"}`
        : snapshot.restored ? `Restored workspace: ${path}\nBranch: ${snapshot.branchId}\nCurrent connection: ${connection}${route ? ` · ${route}` : ""}${snapshot.profile ? ` · profile:${snapshot.profile}` : ""}` : "")).split("\n").map(line => fitLine(line, width)).join("\n");
      const action = snapshot.readiness === "loading" ? "Checking connection · Type a task · Esc cancel"
        : snapshot.readiness === "ready" ? "Type a task · Enter sends"
        : snapshot.readiness === "connect" ? "Connect to continue · Alt+L sign in"
        : snapshot.readiness === "choose-model" ? "Choose a model · Alt+M browse models"
        : snapshot.recovery?.category === "credential-store" ? "Unlock credential storage · Ctrl+R retry"
        : "Repair connection · Alt+M choose model";
      // The top bar already names the workspace; repeat it only when that bar is hidden.
      empty.content = snapshot.readiness === "not-connected" ? new StyledText([
        ...(topBar.visible ? [] : [fg(theme.muted)(`${safe(path)}\n`)]),
        bold(fg(theme.text)("Not connected")), fg(theme.muted)("\n"),
        ...keyHintChunks("Connect a provider · Alt+L", hintColors(theme.background)),
      ]) : new StyledText([
        ...(topBar.visible ? [] : [fg(theme.muted)(`${safe(path)}\n`)]),
        bold(fg(theme.text)(safe(connection))),
        ...(snapshot.modelId ? [fg(theme.muted)(safe(` · ${route}\n\n`))] : [fg(theme.muted)("\n\n")]),
        ...(snapshot.readinessDetail ? [fg(snapshot.readiness === "ready" || snapshot.readiness === "loading" ? theme.muted : theme.warning)(`${safe(snapshot.readinessDetail)}\n`)] : []),
        ...keyHintChunks(safe(action), hintColors(theme.background)),
        ...(snapshot.recovery?.actions.includes("details") ? [fg(theme.muted)("\n"), ...keyHintChunks("F2 details · Esc keep editing", hintColors(theme.background))] : []),
      ]);
      paintTaskExamples(snapshot, path, connection, route, action, width, draftStatus.visible ? draftStatus.height : 0);
      const ids = new Set(entries.map(entry => entry.id));
      if (previousInspection && !inspectionEntry(previousInspection, entries)) previousInspection = undefined;
      if (inspection && !inspectionEntry(inspection, entries)) clearInspection();
      for (const [id, row] of rows) if (!ids.has(id)) { row.root.destroyRecursively(); rows.delete(id); }
      const updateRow = (row: TranscriptItemView, entry: TuiTranscriptEntry) => {
        // OpenTUI 0.5.11 caches finalized Markdown prefixes. A notice may follow an
        // active answer; finalizing that row early permanently splits later deltas.
        row.update({ ...entry, text: safe(entry.text), toolName: entry.toolName ? safe(entry.toolName) : undefined, toolSummary: entry.toolSummary ? safe(entry.toolSummary) : undefined,
            resultSummary: entry.resultSummary ? safe(entry.resultSummary) : undefined, diffRows: entry.diffRows?.map(row => ({ ...row, text: safe(row.text) })),
          }, (allExpanded || entry.toolStatus === "error") !== expandedTools.has(entry.id), entry.id === snapshot.streamingAssistantId, width - 1,
          inspection?.id === entry.id && inspection.kind === "code" ? inspection.index : undefined,
          inspection?.id === entry.id && inspection.kind === "tool", controller.inlineDiffLines(),
          inspection?.id === entry.id && inspection.kind === "table" ? inspection.index : undefined);
      };
      for (const entry of entries) {
        let row = rows.get(entry.id);
        if (!row) {
          row = createTranscriptItem(renderer, entry, theme, syntax, () => {
            const current = controller.snapshot().transcript.find(item => item.id === entry.id);
            if (current && hasInlineDiff(current, controller.inlineDiffLines())) return;
            if (expandedTools.has(entry.id)) expandedTools.delete(entry.id); else expandedTools.add(entry.id);
            refresh();
          }, { now, mode: motion });
          rows.set(entry.id, row);
          transcript.add(row.root);
        }
        updateRow(row, entry);
      }
      if (inspection) {
        if (!validInspection(inspection, entries)) {
          const entry = entries.find(entry => entry.id === inspection!.id), row = rows.get(inspection.id);
          clearInspection();
          if (entry && row) updateRow(row, entry);
        }
        else if (inspection.kind !== "tool") {
          inspection.source = safe(entries.find(entry => entry.id === inspection!.id)!.text);
          inspection.text = blockText(inspection)!;
        }
      }
      const inspectedText = inspection && inspectionText(inspection, entries);
      renderedInspection = inspection && inspectedText !== undefined ? { target: inspection, source: inspection.kind !== "tool" ? inspection.source : undefined, text: inspectedText } : undefined;
      if (searchOpen) {
        const query = editor.plainText;
        const previous = searchResult.matches[searchSelected];
        const previousResult = searchResult;
        const changedQuery = query !== searchLastQuery;
        searchLastQuery = query;
        searchResult = searchIndex.update(entries.map(entry => ({ id: entry.id, kind: entry.kind, segments: rows.get(entry.id)!.searchSegments().map(segment => segment.text) })), query);
        if (changedQuery) {
          searchSelected = searchResult.matches.length ? 0 : -1;
          searchScrollToMatch = searchSelected >= 0;
        } else if (previous && searchResult !== previousResult) {
          const preserved = searchResult.matches.findIndex(match => match.id === previous.id && match.segment === previous.segment && match.offset === previous.offset);
          searchSelected = preserved >= 0 ? preserved : Math.min(searchSelected, searchResult.matches.length - 1);
        } else searchSelected = searchResult.matches.length ? Math.max(0, Math.min(searchSelected, searchResult.matches.length - 1)) : -1;
      }
      const selectedSearchId = searchOpen ? searchResult.matches[searchSelected]?.id : undefined;
      for (const [id, row] of rows) row.setSearchMatch(id === selectedSearchId);
      const searchStatus = !editor.plainText ? "Find in this branch · Type a query" : searchResult.matches.length
        ? `Find ${searchSelected + 1}/${searchResult.matches.length}${searchResult.limited ? "+ (limited)" : ""} · active branch, displayed text`
        : `No matches${searchResult.limited ? " in searched portion" : " in this branch"} · Edit query · Esc back`;
      footerParts.override = searchOpen && !activity.visible ? searchStatus : undefined;
      const completed = snapshot.outcome;
      // Alt+R review and F2 details act only from the conversation; panels and the reader own those keys, and open details ignore F2.
      const outcomeText = completed ? formatOutcomeLine(completed, width, !panelMode && !reader, !!detailsReturn) : "";
      const outcomeGlyph = completed ? outcomeText.split(" ")[0] : undefined;
      const outcomeTone = completed ? ({ completed: "success", failed: "error", cancelled: "muted", limit: "warning" } as const)[completed.reason] : "muted";
      activityPaint = snapshot.activity?.phase === "stopping" ? { text: activityDetail(snapshot.activity), tone: "warning", glyph: "◌" }
        : snapshot.toolApproval ? { text: `${width >= 40 ? "Approval required" : "Approval"} · Ctrl+C cancel turn`, tone: "warning", glyph: "◌", chips: true }
        : searchOpen ? { text: searchStatus, tone: "accent", glyph: "⌕" }
        : Date.now() < interactionNoticeUntil ? { text: interactionNotice, tone: "muted" }
        : unseen ? { text: "New activity · Ctrl+End to return to latest", tone: "accent", glyph: "↓", chips: true }
        : snapshot.branchTreeError ? { text: safe(snapshot.branchTreeError), tone: "error", glyph: "!" }
        : snapshot.activity ? { text: activityDetail(snapshot.activity), tone: "accent", spin: true }
        : snapshot.status === "running" ? { text: "Working · Esc stop", tone: "accent", spin: true }
        : outcomeText ? { text: outcomeText.slice(outcomeGlyph!.length + 1), tone: outcomeTone, glyph: outcomeGlyph, outcome: true } : { text: "", tone: "muted" };
      activity.onMouseUp = () => { if (!searchOpen) { latest(); refresh(); } };

      const browsing = panelMode === "help" || (!panelMode && !reader && editor.plainText.startsWith("/") && editor.plainText !== dismissedQuery && !commandArguments(editor.plainText));
      if (browsing && !discoveryOpen) refreshDiscovery();
      discoveryOpen = browsing;
      // Guidance belongs to the query it was opened from; any query edit returns to results.
      if (helpGuide && (panelMode !== "help" || helpInserted || editor.plainText !== helpGuide.query)) helpGuide = undefined;
      const available = completions();
      if (editor.plainText !== lastQuery) { completionIndex = available.findIndex(paletteSelectable); completionId = available[completionIndex]?.id; lastQuery = editor.plainText; completionChosen = false; }
      else if (completionId) completionIndex = available.findIndex(entry => entry.id === completionId && paletteSelectable(entry));
      else completionIndex = -1;
      const commandRows = paletteRows(available);
      const helpResults = panelMode === "help" && !helpInserted;
      const guide = helpGuide && available.find((entry): entry is KeyboardGuideChoice => entry.id === helpGuide!.id && entry.kind === "keyboard");
      // The compact status bar names the palette's own Esc verb, as the hint row does.
      if (panelMode === "help" && !snapshot.toolApproval) footerParts.nextAction = paletteEscape(!!guide);
      const paletteNote = !helpResults || guide || !available.length ? "" : snapshot.toolApproval ? PALETTE_APPROVAL : controller.running || snapshot.status === "running" ? PALETTE_RUNNING : "";
      const selectedDetail = helpResults && !guide ? paletteDetail(available[completionIndex]) : undefined;
      picker.visible = !!snapshot.loginChooser || !!snapshot.loginApproval || !!snapshot.modelPicker || !!snapshot.sessionPicker || browsing;
      const maxRows = snapshot.modelPicker ? Math.max(1, Math.min(12, renderer.height - 10))
        : Math.max(1, Math.min(snapshot.loginChooser ? 8 : 6, Math.floor(renderer.height / 3) - 2));
      const legacyDevice = snapshot.loginApproval && !snapshot.loginApprovalData ? /^Enter this code at (.*?): (.+)$/.exec(snapshot.loginApproval) : null;
      const deviceApproval = snapshot.loginApprovalData?.kind === "device"
        ? { address: snapshot.loginApprovalData.verificationUri.replace(/^https:\/\//, "").replace(/\/$/, ""), code: snapshot.loginApprovalData.userCode }
        : legacyDevice ? { address: legacyDevice[1]!, code: legacyDevice[2]! } : undefined;
      const splitApproval = !!deviceApproval && (!snapshot.loginApprovalData || Bun.stringWidth(snapshot.loginApproval ?? "") > width - 2);
      const approvalRows = splitApproval
        ? (!snapshot.loginApprovalData && renderer.height >= 12 ? 1 : 0) + Math.ceil(Bun.stringWidth(deviceApproval!.code)/(width - 2)) + Math.ceil(Bun.stringWidth(deviceApproval!.address)/(width - 2))
        : snapshot.loginApprovalData ? Math.max(1, Math.ceil(Bun.stringWidth(snapshot.loginApproval ?? "")/(width - 2))) : 2;
      const sessionVisibleRows = renderer.height < 14 ? 1 : maxRows;
      const pickerRows = snapshot.sessionPicker ? Math.max(1, Math.min(sessionVisibleRows, snapshot.sessionPicker.entries.length)) + 2 + (renderer.height >= 12 ? 1 : 0) + (renderer.height >= 14 ? 1 : 0) + (renderer.height >= 10 ? 1 : 0) : snapshot.loginChooser ? Math.min(maxRows, snapshot.loginChooser.rows.length) + 1 : snapshot.loginApproval ? approvalRows : snapshot.modelPicker ? Math.min(maxRows, snapshot.modelPicker.entries.length) + 2 : guide ? guidanceHeight(guide, width - 2) : Math.max(1, Math.min(maxRows, commandRows.length)) + (paletteNote ? 1 : 0) + (selectedDetail ? 1 : 0);
      const chromeRows = (topBar.visible ? 1 + (renderer.height >= 20 ? 1 : 0) : 0) + (activity.visible ? 1 + (renderer.height >= 20 ? 1 : 0) : 0) + (hints.visible ? 1 : 0) + (draftStatus.visible ? draftStatus.height : 0) + 3;
      // Reserve the transcript, composer borders, status and picker before
      // allowing the editor to grow. A wrapping placeholder also consumes rows.
      editor.maxHeight = searchOpen ? 1 : Math.max(1, Math.min(6, Math.floor(renderer.height / 4), renderer.height - chromeRows - pickerRows - 1));
      const panelKey = JSON.stringify([snapshot.preferences, snapshot.loginChooser, snapshot.loginApproval, snapshot.loginApprovalData, snapshot.sessionPicker, snapshot.modelPicker, snapshot.branchTree, available, completionIndex, guide?.id, paletteNote, width, renderer.height]);
      if (panelKey !== panelFingerprint) {
        panelFingerprint = panelKey;
        clear(picker);
        clear(preferencePanel);
        if (snapshot.preferences) {
          const panel = snapshot.preferences;
          const compact = renderer.width < 45 || renderer.height < 16;
          const lines = preferenceLines(panel, compact);
          // Rows wrap one cell short of the panel whether or not the scrollbar shows, so it never clips a row's last word.
          preferencePanel.content.minWidth = preferencePanel.content.maxWidth = Math.max(1, width - 1);
          for (const [index, line] of lines.entries()) textRow(preferencePanel, safe(compact && index < 3 ? fitLine(line, width - 1) : line), theme.text).wrapMode = "word";
          preferencePanel.scrollTo(0);
        } else if (snapshot.loginChooser) {
          const panel = snapshot.loginChooser;
          const title = panel.level === "main" ? "Sign in" : `${panel.level === "chatgpt" ? "ChatGPT" : "Grok"} · more options`;
          textRow(picker, fitLine(title, width - 2), theme.accent);
          const selectedIndex = panel.rows.findIndex(row => row.kind === "choice" && row.id === panel.selectedId);
          const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), panel.rows.length - maxRows));
          const labelWidth = Math.max(...panel.rows.map(row => row.kind === "choice" ? row.label.length : 0));
          const room = width - 2;
          // Hide the details column together when its widest entry cannot fit the current level.
          const detailsFit = panel.rows.every(row => row.kind !== "choice" || !row.detail || 4 + 2 + labelWidth + 2 + row.detail.length <= room);
          for (const row of panel.rows.slice(start, start + maxRows)) {
            if (row.kind === "group") { textRow(picker, `  ${fitLine(row.label, room - 2)}`, theme.muted); continue; }
            const selected = row.id === panel.selectedId;
            const prefix = `    ${selected ? "› " : "  "}`;
            const chunks = [fg(selected ? theme.accent : theme.text)(`${prefix}${fitLine(row.label, room - prefix.length)}`)];
            if (detailsFit && row.detail) chunks.push(fg(selected ? textOn(theme.muted, tint(theme, theme.accent)) : theme.muted)(`${" ".repeat(labelWidth - row.label.length + 2)}${row.detail}`));
            const item = textRow(picker, "");
            item.content = new StyledText(chunks);
            if (selected) item.bg = tint(theme, theme.accent);
          }
        } else if (snapshot.loginApproval) {
          if (!snapshot.loginApprovalData && renderer.height >= 12) textRow(picker, "Complete ChatGPT approval · Esc cancels", theme.accent);
          if (splitApproval) {
            textRow(picker, deviceApproval!.code, theme.accent).wrapMode = "char";
            textRow(picker, deviceApproval!.address, theme.text).wrapMode = "char";
          } else textRow(picker, snapshot.loginApproval, theme.text).wrapMode = "char";
        } else if (snapshot.sessionPicker) {
          const sessions = snapshot.sessionPicker;
          if (renderer.height >= 12) textRow(picker, fitLine(`${sessions.hasMore ? `Recent sessions · Ctrl+L load ${formatCount(100, "more session")}` : "Recent sessions"} · ${sessions.allWorkspaces ? "All workspaces + recovery" : "Current workspace"} · Ctrl+W scope`, width - 2), theme.accent);
          const start = Math.max(0, sessions.selectedIndex - sessionVisibleRows + 1);
          sessions.entries.slice(start, start + sessionVisibleRows).forEach((entry, index) => {
            textRow(picker, fitLine(`${start + index === sessions.selectedIndex ? "›" : " "} ${entry.id === snapshot.sessionId ? "● current · " : ""}${entry.title} · ${entry.activityAt ?? "activity unknown"}`, width - 2), start + index === sessions.selectedIndex ? theme.accent : theme.text);
          });
          const selected = sessions.entries[sessions.selectedIndex];
          if (!selected) textRow(picker, fitLine("No results · ^W scope", width - 2), theme.muted);
          const activity = selected?.activityAt ? selected.activityAt.slice(0, 16).replace("T", " ") : "Activity unknown";
          textRow(picker, fitLine(width >= 50 ? `Last activity: ${selected?.activityAt ?? "unknown"}` : activity, width - 2), theme.muted);
          if (renderer.height >= 14) textRow(picker, fitLine(selected ? `${selected.workspaceRoot ? shortenWorkspacePath(selected.workspaceRoot, options.home, width - 2) : "Unknown workspace"} · ${selected.id}` : "Ctrl+W includes other workspaces and recovery files", width - 2), theme.muted);
          if (renderer.height >= 10) textRow(picker, fitLine(sessions.error ?? (sessions.loading ? "Loading…" : selected?.state ?? "Nothing selected"), width - 2), sessions.error ? theme.error : theme.muted);
          textRow(picker, fitLine(width < 60 ? "↑↓ Enter Esc ^W ^L" : `↑↓ preview · PgUp/PgDn page · Enter resume · Esc restore · ${sessions.total ? sessions.offset + sessions.selectedIndex + 1 : 0}/${sessions.total}`, width - 2), theme.muted);
        } else if (snapshot.modelPicker) {
          const models = snapshot.modelPicker;
          if (editor.plainText !== models.query) setDraft(models.query);
          const room = Math.max(1, width - 2);
          textRow(picker, fitLine(`${models.connecting ? "Connect a provider" : "Choose model"} · Enter ${modelPickerAction(models.entries[models.selectedIndex])} · Esc back`, room), theme.accent);
          const start = Math.max(0, Math.min(models.selectedIndex - Math.floor(maxRows / 2), models.entries.length - maxRows));
          models.entries.slice(start, start + maxRows).forEach((entry, offset) => {
            const selected = start + offset === models.selectedIndex;
            const prefix = `${selected ? "›" : " "} `;
            let line = entry.groupLabel;
            if (entry.kind === "model") {
              const route = entry.provider === "openai-compatible" ? `API · ${entry.groupLabel.replace(/^OpenAI-compatible · /, "")}` : entry.groupLabel;
              const marks = `${entry.active ? "✓" : ""}${entry.favorite ? "★" : ""}`;
              const label = modelPickerName(entry.modelId);
              const suffix = ` · ${route}${marks ? " " + marks : ""}`;
              line = fitLine(label, Math.max(4, room - 2 - Bun.stringWidth(suffix))) + suffix;
            }
            textRow(picker, fitLine(prefix + line, room), selected ? theme.accent : theme.text);
          });
          const selected = models.entries[models.selectedIndex];
          const detail = models.details && selected?.kind === "model"
            ? `${selected.modelId} · ${selected.contextWindow.toLocaleString("en-US")} context · ${selected.maxOutput.toLocaleString("en-US")} output`
            : models.loading ? "Checking models · Esc back" : models.connecting ? "Type to search · ↑↓ select · Esc back" : selected?.kind === "model" ? `Type to search · Ctrl+P ${selected.favorite ? "unpin" : "pin"} · F2 details` : "↑↓ select · Enter open · Esc back";
          textRow(picker, fitLine(models.error ?? detail, room), models.error ? theme.error : theme.muted);
        } else if (browsing && guide) {
          const tones = { accent: theme.accent, text: theme.text, muted: theme.muted, warning: theme.warning, success: theme.success };
          for (const line of guidanceLines(guide)) textRow(picker, line.text, tones[line.tone]);
        } else if (browsing) {
          const selectedRow = commandRows.findIndex(row => "index" in row && row.index === completionIndex);
          const start = Math.max(0, Math.min(selectedRow - Math.floor(maxRows / 2), commandRows.length - maxRows));
          const nameColumns = Math.min(23, Math.max(1, ...available.map(entry => Bun.stringWidth(entry.kind === "keyboard" ? entry.shortcut : `/${safe(entry.name)}`))));
          if (!available.length) textRow(picker, helpResults ? PALETTE_NO_MATCHES : "No matches · Esc keep editing", theme.muted);
          if (paletteNote) textRow(picker, fitLine(paletteNote, width - 2), theme.muted).wrapMode = "none";
          commandRows.slice(start, start + maxRows).forEach(row => {
            if ("header" in row) textRow(picker, `    ${row.header}`, theme.muted);
            else if (row.entry.kind === "keyboard") keyboardRow(row.entry, row.index === completionIndex, nameColumns, width - 2);
            else commandRow(row.entry, row.index === completionIndex, nameColumns, width - 2);
          });
          if (selectedDetail) textRow(picker, fitLine(selectedDetail.text, width - 2), selectedDetail.warning ? theme.warning : theme.muted).wrapMode = "none";
        }
        // Selected choices become a tinted row so the highlight reads as a block, not only a marker.
        for (const child of picker.getChildren()) {
          if (child instanceof TextRenderable && child.plainText.startsWith("› ")) { child.bg = tint(theme, theme.accent); child.fg = theme.text; }
        }
        if (snapshot.branchTree) {
          clear(tree);
          const branches = snapshot.branchTree;
          if (renderer.height >= 16) textRow(tree, "Conversation branches", theme.accent);
          if (renderer.height >= 12) {
            textRow(tree, fitLine(`● Active: ${branches.activeBranchLabel ?? branches.activeBranchId}`, width), theme.muted);
            textRow(tree, fitLine(branches.selectedBranchId ? "Continue existing · Tab: new fork" : "New fork · Tab: existing", width), theme.accent);
          }
          if (renderer.height >= 16) textRow(tree, "↑/↓ preview · Enter confirm · Esc cancel", theme.muted);
          const visibleRows = Math.max(1, Math.min(8, renderer.height - 14));
          if (branches.selectedBranchId) {
            const selectedIndex = branches.branches.findIndex(branch => branch.id === branches.selectedBranchId);
            const start = Math.max(0, selectedIndex - Math.min(1, visibleRows - 1));
            branches.branches.slice(start, start + visibleRows).forEach((branch, offset) => {
              const index = start + offset;
              const selected = branch.id === branches.selectedBranchId;
              const ordinal = (branches.branchOffset ?? 0) + index + 1;
              const row = textRow(tree, fitLine(`${selected ? "›" : " "}${branch.active ? "●" : " "} ${ordinal}. ${branch.name || branch.preview}`, width), selected ? theme.accent : theme.text);
              row.id = `branch-choice-${branch.id}`;
            });
            textRow(tree, `● active · › preview · ${formatCount(branches.totalBranchCount ?? branches.branches.length, "path")}`, theme.muted);
          } else {
            const points = branches.nodes.filter(node => node.isForkPoint);
            const selectedIndex = points.findIndex(node => node.id === branches.selectedId);
            const start = Math.max(0, selectedIndex - Math.min(1, visibleRows - 1));
            for (const node of points.slice(start, start + visibleRows)) {
              const row = textRow(tree, fitLine(`${node.id === branches.selectedId ? "›" : " "}${node.isActiveHead ? "●" : " "} ${node.preview}`, width), node.id === branches.selectedId ? theme.accent : theme.text);
              row.id = `branch-${node.id}`;
            }
            if (branches.truncated) textRow(tree, "Windowed turns · arrows browse all complete turns", theme.warning);
          }
          const previewKey = `${key}/${branches.selectedId}/${branches.totalNodeCount}`;
          if (previewKey !== treePreviewKey) {
            treePreviewKey = previewKey;
            try { treePreview = controller.previewBranchTreeNode(branches.selectedId).slice(-MAX_BRANCH_TREE_PREVIEW_ENTRIES); }
            catch { treePreview = [{ id: "error", kind: "error", text: "Preview unavailable · /branch tree retry" }]; }
          }
          textRow(tree, "\nPreview", theme.accent);
          textRow(tree, treePreview.map(entry => `${entry.kind}: ${entry.text.slice(0, 1200)}`).join("\n\n") || "Empty conversation", theme.muted);
          tree.scrollChildIntoView(branches.selectedBranchId ? `branch-choice-${branches.selectedBranchId}` : `branch-${branches.selectedId}`);
        }
      }
      hints.height = panelMode === "review" || panelMode === "history" ? "auto" : 1;
      hints.wrapMode = panelMode === "review" || panelMode === "history" ? "word" : "none";
      if (reader) {
        const navigation = reader.search ? ["↑↓ next", "Enter keep"] : ["↑↓ scroll", ...(reader.layout?.viewport.wrap ? [] : [reader.document.kind === "table" && reader.document.aligned ? "←→ columns" : "←→ pan"]),
          ...(reader.document.kind === "code" ? [reader.wrap ? "W unwrap" : "W wrap"] : []), "C copy", "Ctrl+F find"];
        // Esc leads so narrow hint rows keep the way out when trailing actions are dropped.
        hints.content = fittedHints([snapshot.toolApproval ? "Esc back to request" : reader.search ? "Esc restore" : "Esc back", ...navigation].join(" · "), width, theme.background, true);
      } else if (snapshot.toolApproval && panelMode !== "tool-approval") {
        hints.content = "Esc back to request";
      } else if (panelMode === "tool-approval" && snapshot.toolApproval) {
        hints.content = fittedHints(approvalHint(snapshot.toolApproval.selected, snapshot.toolApproval.enteringReason, !!toolApprovalLayout?.overflow), width);
      } else if (panelMode === "undo") {
        hints.content = undoHint(snapshot.undoPreview, width);
      } else if (panelMode === "history" && snapshot.history) {
        const history = snapshot.history;
        const files = history.turns[history.selected]?.files.items.length ?? 0;
        const [navigation, actions] = history.loading ? ["", "Esc back"]
          : history.showingDetails ? ["PgUp/PgDn scroll", "F2 back · Esc back"]
          : history.view === "current" ? ["PgUp/PgDn scroll", "Esc back"]
          : history.view === "detail" ? [files ? "↑↓ files · Enter current diff" : "PgUp/PgDn scroll", "F2 details · Esc back"]
          : history.total ? ["↑↓ select · Enter open", "F2 details · Esc back"] : ["", "Esc back"];
        // Keep each key with its action when the hint needs a second row, as in review.
        const separator = navigation && Bun.stringWidth(`${navigation} · ${actions}`) > width ? "\n" : navigation ? " · " : "";
        hints.content = new StyledText([...(navigation ? keyHintChunks(navigation, hintColors(theme.background)) : []), fg(theme.muted)(separator), ...keyHintChunks(actions, hintColors(theme.background))]);
      } else if (panelMode === "review") {
        const navigation = snapshot.changeReview?.showingDetails || !snapshot.changeReview?.files.length ? "PgUp/PgDn scroll" : "↑↓ files · PgUp/PgDn scroll";
        const reload = (snapshot.changeReview?.scope || snapshot.changeReview?.fromUndo) && !snapshot.changeReview.showingDetails ? "Ctrl+R reload · " : "";
        // An undo-panel review keeps its Details gated on a live turn, as before current-changes review existed.
        const details = !!snapshot.changeReview?.scope || !!snapshot.changeReview?.fromUndo && !!snapshot.outcome;
        const actions = `${reload}${details ? snapshot.changeReview?.showingDetails ? "F2 files · " : "F2 details · " : ""}Esc back`;
        // Keep each key with its action when the review hint needs a second row.
        const separator = Bun.stringWidth(`${navigation} · ${actions}`) > width ? "\n" : " · ";
        hints.content = new StyledText([...keyHintChunks(navigation, hintColors(theme.background)), fg(theme.muted)(separator), ...keyHintChunks(actions, hintColors(theme.background))]);
      } else if (snapshot.modelPicker) {
        hints.content = fittedHints(`↑↓ select · Enter ${modelPickerAction(snapshot.modelPicker.entries[snapshot.modelPicker.selectedIndex])} · Esc back`, width);
      } else {
        const modeHint = "Shift+Tab change mode · ";
        const working = !!snapshot.activity || snapshot.status === "running";
        // Text typed during work is an unsent draft; failed work or a blocked session leads with its real next step, never Enter send.
        const recoveryKeys = blockedSubmitHint(snapshot);
        const composerHint = working ? chunkWidth(keyHintChunks(RUNNING_DRAFT_HINT, hintColors(theme.background))) <= width ? `${RUNNING_DRAFT_HINT} · ${modeHint}` : `${RUNNING_NARROW_HINT} · `
          : recoveryKeys ? `${recoveryKeys} · ${modeHint}` : `${modeHint}${snapshot.readiness === "ready" ? "Enter send · " : ""}`;
        hints.content = fittedHints(snapshot.preferences ? preferenceHint(snapshot.preferences) : snapshot.loginChooser ? `↑↓ select · Enter${snapshot.loginChooser.level === "main" && snapshot.loginChooser.rows.some(row => row.kind === "choice" && row.id === snapshot.loginChooser!.selectedId && row.hasMore) ? " · Tab more options" : ""} · Esc back` : panelMode === "tree" ? "Files/Git unchanged · Enter confirm · Esc back" : panelMode === "help" ? paletteHint({ guide: !!guide, inserted: helpInserted, selected: available[completionIndex] }, width) : searchOpen ? "↑/↓ next/previous · Enter accept · Esc restore · Ctrl+End latest" : panelMode === "credential" ? "Enter save · Esc cancel" : panelMode === "callback" ? "Enter sign in · Esc cancel" : panelMode ? "Enter confirm · Esc back" : detailsReturn ? "PgUp/PgDn scroll · Esc back" : inspection ? inspection.kind === "tool" ? "↑↓ move · Enter toggle · C copy · Esc back" : "↑↓ move · R read · C copy · Esc back" : available.length ? slashPaletteHint({ enter: slashEnter(available[completionIndex], editor.plainText, { choices: available, chosen: completionChosen }).kind, working }, width) : snapshot.readiness === "not-connected" ? `${modeHint}Alt+L sign in · / commands` : `${composerHint}${renderer.width < 70 ? "Ctrl+F find · Alt+I inspect" : "Ctrl+F find · Alt+I inspect · Ctrl+O tools · / commands"}`, width);
      }
      if (!picker.visible) pickerOpenedAt = undefined;
      else if (!pickerWasVisible && motion === "full") pickerOpenedAt = now();
      pickerWasVisible = picker.visible;
      if (pickerOpenedAt === undefined) picker.height = "auto";
      const focusColor = pill.tone === "stopping" ? theme.warning : pill.tone === "attention" ? theme.error : theme.accent;
      focusBar.fg = focusColor;
      animate();
      ticker.ensure();
    } finally { refreshing = false; }
  }

  function submit() {
    if (panelMode === "tool-approval") {
      if (controller.snapshot().toolApproval?.enteringReason) controller.denyToolApproval(editor.plainText);
      // Enter never acts on a choice the panel could not paint.
      else if (toolApprovalLayout?.fits) controller.chooseToolApproval();
      refresh(); return;
    }
    if (panelMode === "help") {
      // Help only explains keys or inserts commands; a later ordinary Enter owns dispatch and confirmation.
      if (helpGuide) return;
      const selected = helpInserted ? undefined : completions()[completionIndex];
      if (selected?.kind === "keyboard") { helpGuide = { id: selected.id, query: editor.plainText }; refresh(); return; }
      // A waiting approval owns the editor once help closes, so palette text must never reach its reason field.
      if (controller.snapshot().toolApproval) return;
      const command = helpInserted ? editor.plainText : selected?.available ? selected.insertion : undefined;
      if (command !== undefined) { controller.commandHelpOpen = false; refresh(); setDraft(command); refresh(); }
      return;
    }
    if (searchOpen) {
      if (searchScrollToMatch && searchResult.matches[searchSelected]) searchAcceptPending = true;
      else closeSearch(false);
      return;
    }
    const snapshot = controller.snapshot();
    if (snapshot.undoPreview || snapshot.changeReview || snapshot.history) return;
    if (snapshot.readiness === "loading" || snapshot.endpointUrlEntry || snapshot.credentialEntry || snapshot.loginCallbackEntry) return;
    if (snapshot.loginChooser) {
      void controller.selectLoginChoice().then(refresh, fail);
      return;
    }
    if (snapshot.preferences) {
      void controller.selectPreference().then(refresh, fail);
      return;
    }
    if (snapshot.sessionPicker) { void controller.selectPickerSession().then(refresh, fail); return; }
    if (snapshot.modelPicker) {
      void controller.selectPickerModel().then(refresh, fail);
      return;
    }
    if (snapshot.branchTree && !editor.plainText.trim().startsWith("/")) {
      if (controller.confirmBranchTreeSelection(editor.plainText.trim() || undefined)) controller.closeBranchTree();
      refresh(); return;
    }
    // A slash-palette highlight that differs from the draft is inserted, as Tab does; it never dispatches, even while busy.
    const enter = slashEnterAction();
    if (enter.kind === "insert") { setDraft(enter.insertion); refresh(); return; }
    const value = editor.plainText;
    if (!value.trim()) return;
    if (pendingAcceptance) return;
    if (observedDraft !== value) { observedDraft = value; editorRevision++; }
    const revision = editorRevision;
    const submittedDraft = durableDraft;
    const accept = () => {
      pendingAcceptance = false;
      if (!value.trimStart().startsWith("/") && submittedDraft &&
        (submittedDraft.text === value || submittedDraft.store?.checkpoint?.text === value)) {
        const newer = submittedDraft.text !== value ? submittedDraft.text : "";
        clearDurableDraft(submittedDraft);
        if (newer) { submittedDraft.text = newer; submittedDraft.dirty = true; submittedDraft.status = "dirty"; checkpointDraft(submittedDraft); }
      }
      // Credential callback commands must never enter prompt recall.
      if (!value.trimStart().startsWith("/") && history.at(-1) !== value) {
        history.push(value); if (history.length > 100) history.shift();
      }
      historyIndex = -1;
      if (panelMode) {
        if (savedDraftRevision === revision && savedDraft === value) { savedDraft = ""; savedDraftCursor = 0; savedDraftSelection = null; }
      } else if (editorRevision === revision && editor.plainText === value) {
        setDraft("");
      }
      dismissedQuery = undefined;
      latest();
      refresh();
    };
    if (controller.running && /^\/(theme|session)(?:\s|$)/.test(value.trim())) { controller.notice("Wait for this turn · Esc stop"); return; }
    if (/^\/(theme|session)(?:\s|$)/.test(value.trim())) {
      pendingAcceptance = true;
      void controller.commandCollision(value.trim().split(/\s/)[0]!.slice(1)).then(collides => {
        pendingAcceptance = false;
        if (collides || editorRevision !== revision) { refresh(); return; }
        if (controller.running) { controller.notice("Wait for this turn · Esc stop"); refresh(); return; }
        submitLocal();
      }, error => { pendingAcceptance = false; fail(error); });
      return;
    }
    submitLocal();
    function submitLocal() {
      const themeCommand = /^\/theme(?:\s+(.*))?$/.exec(value.trim());
      if (themeCommand) {
        const requested = themeCommand[1]?.trim() || "auto";
        if (!["auto", "dark", "light"].includes(requested)) controller.fail("Usage: /theme [auto|dark|light]");
        else if (controller.hasAppearancePreferences()) {
          pendingAcceptance = true;
          void controller.configCommand(`set appearance ${requested}`).then(applied => {
            pendingAcceptance = false;
            if (applied) accept();
            refresh();
          }, error => { pendingAcceptance = false; fail(error); });
        } else { mode = requested as ThemeMode; applyTheme(); accept(); }
        refresh(); return;
      }
      if (value.trim() === "/session") {
        const workspace = controller.workspaceIdentity();
        controller.notice(`Session: ${snapshot.sessionId}\nConversation branch: ${snapshot.branchId}\nModel: ${snapshot.modelId ? `${snapshot.provider}/${snapshot.modelId}` : "No model yet"}\nPrimary: ${workspace?.root ?? options.workspaceRoot}\nAttached: ${workspace?.extraRoots.join(", ") || "none"}`);
        accept(); refresh(); return;
      }
      pendingAcceptance = true;
      void options.submit(value, accept).then(() => { pendingAcceptance = false; refresh(); }, error => { pendingAcceptance = false; fail(error); });
      refresh();
    }
  }

  function fail(error: unknown) {
    controller.fail(error instanceof Error ? error.message : String(error));
    refresh();
  }

  function closeSearch(restore: boolean) {
    if (!searchOpen) return;
    searchOpen = false;
    searchScrollToMatch = false;
    searchAcceptPending = false;
    searchIndex.clear();
    if (restore) searchRestoreScroll = searchOriginalScroll;
    refresh();
    if (restore) transcript.scrollTo(searchOriginalScroll);
  }

  /** Select the first reader match at or after the search origin and reveal it. */
  function updateReaderSearch() {
    const state = reader;
    if (!state?.search || !state.layout) return;
    const matches = state.search.query ? state.document.view.search(state.search.query).matches : [];
    const next = matches.findIndex(match => match.start >= state.search!.origin.offset);
    state.search.selected = matches.length ? next >= 0 ? next : 0 : -1;
    state.position = state.search.selected >= 0 ? revealMatch(state.document, state.layout, state.search.origin, matches[state.search.selected]!) : state.search.origin;
  }

  /** The reader owns every key while open; only Ctrl+C keeps its selection, cancel and quit meanings. */
  function readerKey(key: KeyEvent, name: string, snapshot: TuiSnapshot) {
    const state = reader!;
    const layout = state.layout;
    const plain = !key.ctrl && !key.meta && !key.option;
    if (key.ctrl && name === "c") {
      if (copySelection()) renderer.clearSelection();
      else if (controller.running) controller.cancel();
      else options.quit();
      return;
    }
    if (name === "escape") {
      if (snapshot.toolApproval) suspendReader();
      else if (state.search) { state.position = state.search.origin; state.search = undefined; }
      else closeReader();
      return;
    }
    if (!layout) return;
    const document = state.document, viewport = layout.viewport;
    const move = (rows: number) => { state.position = scrollReader(document, layout, state.position, rows); };
    if (state.search) {
      const search = state.search;
      if (name === "return" || name === "kpenter" || key.ctrl && name === "f") { state.search = undefined; return; }
      if (name === "up" || name === "down" || key.ctrl && (name === "p" || name === "n")) {
        const matches = search.query ? document.view.search(search.query).matches : [];
        if (matches.length) {
          search.selected = (search.selected + (name === "up" || name === "p" ? -1 : 1) + matches.length) % matches.length;
          state.position = revealMatch(document, layout, state.position, matches[search.selected]!);
        }
        return;
      }
      if (name === "backspace") {
        const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(search.query)];
        search.query = parts.slice(0, -1).map(part => part.segment).join("");
        updateReaderSearch(); return;
      }
      if (plain && key.sequence && displayText(key.sequence) === key.sequence && !/[\r\n\t]/.test(key.sequence) && name !== "pageup" && name !== "pagedown" && name !== "left" && name !== "right" && name !== "home" && name !== "end") {
        search.query += key.sequence;
        updateReaderSearch(); return;
      }
    }
    if (name === "up" || name === "down") move(name === "up" ? -1 : 1);
    else if (name === "pageup" || name === "pagedown") move((name === "pageup" ? -1 : 1) * Math.max(1, viewport.rows - 1));
    else if (name === "home") state.position = readerBodyPosition(document, layout, { offset: 0, horizontal: 0 });
    else if (name === "end") state.position = readerEnd(document, layout, state.position.horizontal);
    else if ((name === "left" || name === "right") && !viewport.wrap) {
      state.position = { offset: state.position.offset, horizontal: panReader(document, layout, state.position, name === "left" ? -1 : 1) };
    } else if (plain && name === "w" && document.kind === "code") state.wrap = !state.wrap;
    else if (plain && name === "c") copyReader();
    else if (key.ctrl && name === "f") state.search = { query: "", selected: -1, origin: state.position };
  }

  function onKey(key: KeyEvent) {
    // Any key skips the splash and still reaches the editor or the active panel.
    if (splash) { endSplash(); refresh(); }
    if (draftFrozen) { key.preventDefault(); key.stopPropagation(); return; }
    if (key.defaultPrevented || key.eventType === "release" || controller.snapshot().endpointUrlEntry || controller.snapshot().credentialEntry || controller.snapshot().loginCallbackEntry) return;
    const name = key.name.toLowerCase();
    const snapshot = controller.snapshot();
    const handled = () => { key.preventDefault(); key.stopPropagation(); refresh(); };
    const detailsKey = name === "f2" && !key.ctrl && !key.shift && !key.meta && !key.option || key.ctrl && name === "i" && !key.meta && !key.option;
    // Approval owns input even while transcript inspection hides its panel.
    if (detailsKey && snapshot.toolApproval) { handled(); return; }
    if (panelMode === "tool-approval" && snapshot.toolApproval) {
      if (key.ctrl && name === "c") { controller.cancel(); handled(); return; }
      if (name === "escape") { controller.denyToolApproval(); handled(); return; }
      if (name === "tab" && key.shift) { handled(); return; }
      if (name === "pageup" || name === "pagedown") {
        toolApprovalScroll.scrollBy((name === "pageup" ? -1 : 1) * Math.max(1, toolApprovalScroll.viewport.height - 2));
        handled(); return;
      }
      if (name === "return" || name === "kpenter") { submit(); handled(); return; }
      if (!snapshot.toolApproval.enteringReason) {
        if (name === "up" || name === "down") controller.moveToolApproval(name === "up" ? -1 : 1);
        handled(); return;
      }
      if (key.meta || key.option || key.ctrl && !["a", "e", "u", "k", "w", "j"].includes(name)) { handled(); return; }
      return;
    }
    if (reader) { readerKey(key, name, snapshot); handled(); return; }
    if ((key.meta || key.option) && name === "d" && !panelMode && options.draftPersistence) {
      if (clearDurableDraft()) { setDraft(""); savedDraft = ""; }
      handled(); return;
    }
    if (snapshot.sessionPicker) {
      if (name === "escape") { if (controller.running) controller.cancel(); else controller.closeSessionPicker(); handled(); return; }
      if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") { controller.moveSessionPicker(name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -8 : 8); handled(); return; }
      if (key.ctrl && name === "w") { controller.toggleSessionScope(); handled(); return; }
      if (key.ctrl && name === "l") { void controller.loadMoreSessionPicker().then(refresh, fail); handled(); return; }
      if (key.meta || key.option || name === "tab") { handled(); return; }
    }
    if ((key.meta || key.option) && name === "b" && !panelMode && !searchOpen && !controller.running && snapshot.recentSession) {
      void options.submit(`/resume ${snapshot.recentSession.id}`, () => {}).then(refresh, fail); handled(); return;
    }
    if ((key.meta || key.option) && name === "s" && !panelMode && !controller.running) { void options.submit("/sessions", () => {}).then(refresh, fail); handled(); return; }
    if (snapshot.history) {
      const history = snapshot.history;
      if (detailsKey) controller.toggleHistoryDetails();
      else if (name === "escape") controller.historyBack();
      else if (name === "pageup" || name === "pagedown") historyPanel.page(name === "pageup" ? -1 : 1);
      else if (!history.showingDetails && (name === "up" || name === "down")) controller.moveHistory(name === "up" ? -1 : 1);
      else if (!history.showingDetails && (name === "return" || name === "kpenter" || name === "enter")) {
        if (history.view === "list") controller.openHistoryDetail();
        else if (history.view === "detail") void controller.inspectHistoryCurrent().then(refresh, fail);
      }
      handled(); return;
    }
    if (snapshot.undoPreview) {
      if (name === "escape") controller.closeUndoPreview();
      else if (name === "return" || name === "enter") void controller.applyUndo().then(refresh, fail);
      else if ((key.meta || key.option) && name === "r") void controller.reviewUndoChanges().then(refresh, fail);
      else if (name === "up" || name === "down") { controller.selectUndoFile(name === "up" ? -1 : 1); reviewDiff.scrollTo(0); }
      else if (name === "pageup" || name === "pagedown") reviewDiff.scrollBy((name === "pageup" ? -1 : 1) * Math.max(1, reviewDiff.viewport.height - 2));
      handled(); return;
    }
    if (snapshot.changeReview) {
      if (detailsKey || name === "escape" && snapshot.changeReview.showingDetails) {
        const review = snapshot.changeReview, path = review.files[review.selected]?.path;
        if (controller.toggleReviewDetails()) {
          if (review.showingDetails) reviewRestoreScroll = reviewDetailsScroll?.path === path ? reviewDetailsScroll.scroll : 0;
          else { reviewDetailsScroll = { path, scroll: reviewDiff.scrollTop }; reviewRestoreScroll = 0; }
        }
        handled(); return;
      }
      if (name === "escape") { controller.closeChangeReview(); handled(); return; }
      // Reload rereads Git on request only; the turn list and its counts stay as recorded.
      if (key.ctrl && name === "r" && !key.meta && !key.option && !snapshot.changeReview.showingDetails && (snapshot.changeReview.scope || snapshot.changeReview.fromUndo)) {
        void controller.refreshChangeReview().then(refresh, fail); reviewDiff.scrollTo(0); handled(); return;
      }
      if (!snapshot.changeReview.showingDetails && (name === "up" || name === "down")) { void controller.selectReviewFile(name === "up" ? -1 : 1).then(refresh, fail); reviewDiff.scrollTo(0); }
      if (name === "pageup" || name === "pagedown") {
        const distance = Math.max(1, reviewDiff.viewport.height - 2);
        reviewDiff.scrollBy(name === "pageup" ? -distance : distance);
      }
      handled(); return;
    }
    if (detailsKey) {
      if (panelMode === "model") controller.togglePickerDetails();
      else if (!panelMode && !controller.running && snapshot.readiness !== "loading" && !detailsReturn) {
        const prior = { key: sessionKey, scroll: transcript.scrollTop, inspection };
        const opened = snapshot.noticeDetailsAvailable ? controller.inspectNoticeDetails()
          : snapshot.recovery?.actions.includes("details") || snapshot.outcome?.reason === "failed" ? controller.inspectRecovery() : false;
        if (opened) {
          detailsReturn = { ...prior, entryId: controller.snapshot().transcript.at(-1)!.id };
          clearInspection(); transcript.stickyScroll = false; scrollToDetails = true;
        }
      }
      handled(); return;
    }
    if (name === "escape" && detailsReturn && !panelMode && !controller.running && !snapshot.toolApproval) {
      const prior = detailsReturn; detailsReturn = undefined; scrollToDetails = false;
      if (prior.key === sessionKey) {
        inspection = prior.inspection && validInspection(prior.inspection, snapshot.transcript) ? prior.inspection : undefined;
        transcript.stickyScroll = false; searchRestoreScroll = prior.scroll;
        if (inspection) editor.blur(); else editor.focus();
      }
      handled(); return;
    }
    if ((key.meta || key.option) && name === "r" && !panelMode && !controller.running) {
      void controller.openChangeReview().then(refresh, fail); handled(); return;
    }
    if (searchOpen) {
      if (name === "escape") { closeSearch(true); handled(); return; }
      if (key.ctrl && name === "end") { closeSearch(false); latest(); handled(); return; }
      if (name === "return" || name === "kpenter") {
        if (searchScrollToMatch && searchResult.matches[searchSelected]) searchAcceptPending = true;
        else closeSearch(false);
        handled(); return;
      }
      if (name === "up" || name === "down" || (key.ctrl && (name === "p" || name === "n"))) {
        const count = searchResult.matches.length;
        if (count) {
          searchSelected = (searchSelected + (name === "up" || name === "p" ? -1 : 1) + count) % count;
          searchScrollToMatch = true;
        }
        handled(); return;
      }
      if (name === "pageup" || name === "pagedown" || name === "tab" || (key.ctrl && name === "o") || ((key.meta || key.option) && (name === "i" || name === "m")) || (key.ctrl && name === "f")) {
        handled(); return;
      }
      if (key.ctrl && name === "c" && controller.running) { controller.cancel(); handled(); return; }
      return;
    }
    if (snapshot.readiness === "loading" && ((key.meta || key.option) && (name === "m" || name === "l") || key.ctrl && name === "r")) { handled(); return; }
    if ((key.meta || key.option) && name === "l" && !panelMode && !controller.running && !snapshot.recovery?.actions.includes("connect")) {
      controller.openLoginChooser(); handled(); return;
    }
    if (key.ctrl && name === "f" && !panelMode && !inspection) {
      searchOriginalScroll = transcript.scrollTop;
      transcript.stickyScroll = false;
      searchOpen = true;
      searchSelected = -1;
      searchLastQuery = "";
      inspection = undefined;
      scrollToInspection = false;
      searchScrollToMatch = false;
      handled(); return;
    }
    // The search field is one line: Shift+Enter and a legacy Ctrl+J (linefeed) never add a line to the query.
    if (panelMode === "help" && ((key.meta || key.option) || key.ctrl && !["c", "a", "e", "u", "k", "w"].includes(name) || name === "linefeed" || key.shift && (name === "return" || name === "kpenter"))) { handled(); return; }
    if (panelMode === "help" && helpGuide && !(key.ctrl && name === "c")) {
      // Guidance is read-only: Esc returns to the same query and selection, unless approval is waiting behind help.
      if (name === "escape") { helpGuide = undefined; if (snapshot.toolApproval) controller.commandHelpOpen = false; }
      handled(); return;
    }
    if (snapshot.recovery && !panelMode && !controller.running && !snapshot.modelPicker && !snapshot.loginChooser && !snapshot.preferences) {
      if (key.ctrl && name === "r" && snapshot.recovery.actions.includes("retry-credentials")) {
        void controller.retryCredentialRecovery().then(refresh, fail); handled(); return;
      }
      if (key.ctrl && name === "r" && snapshot.recovery.actions.includes("continue")) {
        void controller.continueRecovery().then(refresh, fail); handled(); return;
      }
      if ((key.meta || key.option) && name === "l" && snapshot.recovery.actions.includes("connect")) {
        controller.openRecoveryRepair("connect"); handled(); return;
      }
      if ((key.meta || key.option) && name === "m" && snapshot.recovery.actions.includes("choose-model")) {
        controller.openRecoveryRepair("choose-model"); handled(); return;
      }
      if (!inspection && name === "escape" && snapshot.recovery.actions.includes("keep-editing")) {
        controller.keepEditingRecovery(); handled(); return;
      }
    }
    if (key.ctrl && name === "c" && copySelection()) {
      renderer.clearSelection();
      handled(); return;
    }
    if (inspection) {
      const targets = inspectionTargets(snapshot.transcript);
      const current = targets.findIndex(target => target.id === inspection!.id && target.kind === inspection!.kind && target.index === inspection!.index);
      if (name === "escape" || ((key.meta || key.option) && name === "i")) {
        previousInspection = inspection; clearInspection(); clearInteractionNotice();
        searchRestoreScroll = inspectionOriginalScroll;
        editor.focus(); handled(); return;
      }
      if (name === "up" || name === "down" || name === "tab") {
        const delta = name === "up" || (name === "tab" && key.shift) ? -1 : 1;
        inspection = targets[Math.max(0, Math.min(targets.length - 1, current + delta))];
        scrollToInspection = true; handled(); return;
      }
      if (name === "return" || name === "kpenter") {
        if (inspection.kind === "tool") {
          const entry = snapshot.transcript.find(item => item.id === inspection!.id);
          if (!entry || !hasInlineDiff(entry, controller.inlineDiffLines())) {
            if (expandedTools.has(inspection.id)) expandedTools.delete(inspection.id); else expandedTools.add(inspection.id);
          }
          scrollToInspection = true;
        } else copyInspection(snapshot);
        handled(); return;
      }
      if (key.ctrl && name === "c") { if (controller.running) controller.cancel(); else options.quit(); handled(); return; }
      if (name === "c") { copyInspection(snapshot); handled(); return; }
      if (name === "r" && !key.ctrl && !key.meta && !key.option) { openReader(snapshot); handled(); return; }
      if (key.ctrl && name === "o") { allExpanded = !allExpanded; expandedTools.clear(); handled(); return; }
      if (key.ctrl && name === "end") { latest(); handled(); return; }
      if (name === "pageup" || name === "pagedown") { transcript.scrollBy((name === "pageup" ? -1 : 1) * Math.max(1, transcript.viewport.height - 2)); handled(); return; }
      if (key.ctrl && name === "f") return;
      // Inspection owns input until Esc returns to the unchanged composer.
      handled(); return;
    }
    if (key.ctrl && name === "l") {
      // Re-enter the terminal through the renderer's lifecycle so stale physical
      // cells are repainted even when its cached scene has not changed.
      renderer.suspend();
      renderer.resume();
      handled(); return;
    }
    if ((key.meta || key.option) && name === "p") {
      if (!panelMode && !inspection) controller.openPreferences();
      else if (!snapshot.preferences) showInteractionNotice("Close this panel · Esc back · Alt+P preferences");
      handled(); return;
    }
    if (snapshot.preferences) {
      if (name === "pageup" || name === "pagedown") preferencePanel.scrollBy((name === "pageup" ? -1 : 1) * Math.max(1, preferencePanel.viewport.height - 2));
      else if (name === "escape") controller.closePreferences();
      else if (name === "up" || name === "down") controller.movePreference(name === "up" ? -1 : 1);
      else if (name === "left" || name === "right") controller.movePreference(name === "left" ? -1 : 1, "choice");
      else if (name === "tab") controller.movePreference(key.shift ? -1 : 1, "scope");
      else if (name === "return" || name === "kpenter") void controller.selectPreference().then(refresh, fail);
      else if (key.ctrl && name === "c") { if (controller.running) controller.cancel(); else options.quit(); }
      handled(); return;
    }
    if ((key.meta || key.option) && name === "h" && !panelMode) { controller.openCommandHelp(); handled(); return; }
    if (panelMode === "help" && name === "escape") { controller.commandHelpOpen = false; handled(); return; }
    if ((key.meta || key.option) && name === "m") { controller.openModelPicker(); handled(); return; }
    if ((key.meta || key.option) && name === "i" && !panelMode) {
      inspection = initialInspection(snapshot.transcript);
      if (inspection) { inspectionOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; editor.blur(); scrollToInspection = true; }
      else showInteractionNotice(nothingToInspectReason({ running: controller.running || snapshot.status === "running", blockedSubmit: blockedSubmitHint(snapshot) }));
      handled(); return;
    }
    if (snapshot.modelPicker && key.ctrl && name === "p") { controller.togglePickerFavorite(); handled(); return; }
    if (snapshot.modelPicker?.error && name === "r" && key.ctrl && !key.meta && !key.option &&
      ["empty", "offline", "failed"].includes(snapshot.modelPicker.catalogState ?? "")) {
      controller.retryModelPickerCatalog(); handled(); return;
    }
    if (key.ctrl && name === "o") { allExpanded = !allExpanded; expandedTools.clear(); handled(); return; }
    if (key.ctrl && name === "end") { latest(); handled(); return; }
    if (name === "pageup" || name === "pagedown") {
      const scroller = snapshot.branchTree ? tree : transcript;
      scroller.scrollBy((name === "pageup" ? -1 : 1) * Math.max(1, scroller.viewport.height - 2));
      handled(); return;
    }
    if (name === "escape") {
      if (snapshot.loginChooser) controller.cancel();
      else if (snapshot.modelPicker) controller.backModelPicker();
      else if (snapshot.branchTree) controller.closeBranchTree();
      else if (discoveryOpen) dismissedQuery = editor.plainText;
      else if (controller.cancelPendingSignInListing()) { /* Esc cancels the sign-in listing without changing the saved credential. */ }
      else if (controller.running) controller.cancel();
      handled(); return;
    }
    if (key.ctrl && name === "c") { if (controller.running) controller.cancel(); else options.quit(); handled(); return; }
    if (key.ctrl && name === "d" && !editor.plainText) { options.quit(); handled(); return; }
    if (name === "up" || name === "down") {
      const delta = name === "up" ? -1 : 1;
      if (snapshot.loginChooser) { controller.moveLoginChooser(delta); handled(); return; }
      if (snapshot.modelPicker) { controller.moveModelPicker(delta); handled(); return; }
      if (snapshot.branchTree) { controller.moveBranchTreeAction(delta); handled(); return; }
      const choices = completions();
      if (choices.length) {
        completionIndex = nextPaletteSelection(choices, completionIndex, delta); completionId = choices[completionIndex]?.id; completionChosen = true; handled(); return;
      }
      if (panelMode === "help") { handled(); return; }
      // The visual row is relative to the editor viewport, which only follows edits on the next render, so
      // add the viewport offset and compare against every wrapped row of the current text.
      const visualRow = editor.visualCursor.visualRow + editor.editorView.getViewport().offsetY;
      if (!key.shift && !key.ctrl && !key.meta && history.length && (name === "up" ? visualRow === 0 : visualRow >= editor.editorView.getTotalVirtualLineCount() - 1)) {
        if (historyIndex === -1 && name === "down") return;
        if (historyIndex === -1) { historyDraft = editor.plainText; historyIndex = history.length; }
        historyIndex = Math.max(0, Math.min(history.length, historyIndex + delta));
        setDraft(historyIndex === history.length ? historyDraft : history[historyIndex]!);
        if (historyIndex === history.length) historyIndex = -1;
        handled(); return;
      }
    }
    if (snapshot.loginChooser && (name === "return" || name === "kpenter")) {
      void controller.selectLoginChoice().then(refresh, fail); handled(); return;
    }
    if (snapshot.loginChooser && name === "tab") { controller.openLoginMoreOptions(); handled(); return; }
    if (snapshot.branchTree && name === "tab") { controller.toggleBranchTreeAction(); setDraft(""); handled(); return; }
    if (name === "tab" && key.shift && !panelMode && !searchOpen && !inspection && completions().length === 0) {
      controller.cycleApprovalMode(); handled(); return;
    }
    if (name === "tab" && !key.shift) {
      const selected = completions()[completionIndex];
      if (selected?.kind === "command" && selected.available) {
        if (panelMode === "help") helpInserted = true;
        setDraft(selected.insertion); handled();
      } else if (panelMode === "help") handled();
    }
  }

  editor.onSubmit = submit;
  editor.onContentChange = () => {
    if (refreshing || destroyed) return;
    if (observedDraft !== editor.plainText) { observedDraft = editor.plainText; editorRevision++; }
    if (controller.snapshot().sessionPicker) controller.searchSessions(editor.plainText);
    if (controller.snapshot().modelPicker) controller.searchModels(editor.plainText);
    refresh();
  };
  renderer.keyInput.on("keypress", onKey);
  renderer.on("selection", onSelection);
  const unbindCredential = bindCredentialInput(renderer.keyInput, controller, refresh);
  const onTheme = () => { if ((environmentMode ?? mode) === "auto") applyTheme(); };
  renderer.on("theme_mode", onTheme);
  renderer.on("resize", refresh);
  const scrollToSearchMatch = (match: TranscriptSearchMatch) => {
    const segment = rows.get(match.id)?.searchSegments()[match.segment];
    if (!segment) { transcript.scrollChildIntoView(`message-${match.id}`); return; }
    const target = segment.target;
    let visualLine = segment.visualLine;
    const info = target instanceof TextBufferRenderable ? target.lineInfo : segment.lineInfo;
    if (info) {
      const before = segment.text.normalize("NFC").slice(0, renderedOffsetForFolded(segment.text, match.offset));
      const logicalLine = before.split("\n").length - 1;
      const column = Bun.stringWidth(before.slice(before.lastIndexOf("\n") + 1));
      for (let index = 0; index < info.lineSources.length; index++) {
        if (info.lineSources[index] === logicalLine && info.lineStartCols[index]! <= column) visualLine = segment.visualLine + index;
      }
    }
    const targetTop = transcript.scrollTop + target.y - transcript.viewport.y;
    transcript.scrollTo(targetTop + visualLine - Math.floor(transcript.viewport.height / 2));
  };
  const onFrame = () => {
    if (accentPending) { accentPending = false; accentStartedAt = now(); ticker.ensure(); }
    if (reviewRestoreScroll !== undefined) { reviewDiff.scrollTo(reviewRestoreScroll); reviewRestoreScroll = undefined; }
    if (scrollToDetails && detailsReturn) {
      const row = rows.get(detailsReturn.entryId)?.root;
      if (row) transcript.scrollTo(transcript.scrollTop + row.y - transcript.viewport.y);
      scrollToDetails = false;
    }
    if (searchRestoreScroll !== undefined) {
      transcript.scrollTo(searchRestoreScroll);
      searchRestoreScroll = undefined;
      if (restoreFollow && !layered()) {
        if (grewWhileLayered) latest();
        else if (atBottom()) transcript.stickyScroll = true; else resumeFollowTop = transcript.scrollTop;
      }
      if (!layered()) grewWhileLayered = false;
    } else if (!layered()) { restoreFollow = transcript.stickyScroll && atBottom() || resumeFollowTop !== undefined; grewWhileLayered = false; }
    if (toolApprovalPanel.visible && toolApprovalRows && toolApprovalPanel.height > 0 && toolApprovalPanel.height !== toolApprovalRows.rows) {
      toolApprovalRows = { estimate: toolApprovalRows.estimate, rows: toolApprovalPanel.height };
      refresh();
    }
    if (reader && readerPanel.visible) {
      reader.painted = true;
      if (readerPanel.height > 0 && readerPanel.height !== readerText.height && readerMeasured?.rows !== readerPanel.height) {
        readerMeasured = { width: renderer.width, height: renderer.height, rows: readerPanel.height };
        refresh();
      }
    }
    if (searchOpen && searchScrollToMatch) {
      searchScrollToMatch = false;
      const match = searchResult.matches[searchSelected];
      if (match) scrollToSearchMatch(match);
    }
    if (searchOpen && searchAcceptPending) closeSearch(false);
    let inspectionScrolled = false;
    if (scrollToInspection && inspection) {
      scrollToInspection = false;
      const node = inspectionNode(inspection);
      if (node && (node.y < transcript.viewport.y || node.y >= transcript.viewport.y + transcript.viewport.height)) {
        transcript.scrollTo(transcript.scrollTop + node.y - transcript.viewport.y);
        inspectionScrolled = true;
      }
    }
    if (!inspectionScrolled && inspection && renderedInspection?.target === inspection && inspectionVisible(inspection)) {
      const node = inspectionNode(inspection)!;
      paintedInspection = { ...renderedInspection, node, y: node.y, scroll: transcript.scrollTop, width: renderer.width, height: renderer.height };
    } else paintedInspection = undefined;
    if (paintedCancellationId === undefined) return;
    controller.acknowledgeCancellationFrame(paintedCancellationId);
    paintedCancellationId = undefined;
  };
  renderer.on("frame", onFrame);
  renderer.setBackgroundColor(theme.background);
  editor.focus();
  const activityTimer = setInterval(() => { if (!destroyed && controller.snapshot().activity) refresh(); }, 250);
  const onPaste = (event: PasteEvent) => {
    if (splash) { endSplash(); refresh(); }
    if (reader?.search) {
      event.preventDefault();
      reader.search.query += displayText(new TextDecoder().decode(event.bytes)).replace(/\s+/g, " ");
      updateReaderSearch(); refresh();
    }
  };
  renderer.keyInput.on("paste", onPaste);
  if (fullSplash) {
    splash = new SplashRenderable(renderer, { now, theme: () => theme, version: options.version, seed: (Math.random() * 2 ** 32) >>> 0 });
    splash.onMouseDown = () => { endSplash(); refresh(); };
    renderer.root.add(splash);
    // The editor keeps focus so early typing lands in the draft; only its cursor is hidden under the overlay.
    editor.showCursor = false;
    renderer.requestLive();
  }
  refresh();
  return {
    refresh,
    /** Report the panel mode shown in place of the conversation body, or "" when none is open. */
    panelMode: (): PanelMode | "" => panelMode,
    /** Freeze edits and capture the latest ordinary text without doing any filesystem I/O. */
    freezeDraftForExit(): { task?: ExitDraftCheckpoint; saved: boolean; failed: boolean } {
      const snapshot = controller.snapshot();
      observeDraft(panelMode ? savedDraft : editor.plainText, ["endpoint", "credential", "callback", "approval", "login"].includes(panelMode) || !!snapshot.endpointUrlEntry || !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval || !!snapshot.loginChooser);
      draftFrozen = true;
      for (const state of durableDrafts.values()) { clearTimeout(state.timer); state.timer = undefined; }
      const state = durableDraft;
      if (state && !state.text && !state.store?.checkpoint) return { saved: false, failed: false };
      if (state?.dirty && !state.suppressed && state.store && isOrdinaryDraft(state.text, false, options.secrets)) {
        return { task: { home: options.home, workspaceRoot: state.target.workspaceRoot ?? options.workspaceRoot,
          sessionId: state.target.sessionId, text: state.text, generation: state.store.generation, deferredSession: state.target.deferredSession() }, saved: false, failed: false };
      }
      return draftResult(state);
    },
    /** Attempt one bounded-size synchronous checkpoint without waiting for model/tool settlement. */
    flushDraft() {
      const snapshot = controller.snapshot();
      observeDraft(panelMode ? savedDraft : editor.plainText, ["endpoint", "credential", "callback", "approval", "login"].includes(panelMode) || !!snapshot.endpointUrlEntry || !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval || !!snapshot.loginChooser);
      checkpointDraft();
      return draftResult();
    },
    destroy() {
      if (destroyed) return;
      endSplash();
      destroyed = true;
      inspection = undefined; previousInspection = undefined; renderedInspection = undefined; paintedInspection = undefined;
      reader = undefined; readerReturn = undefined;
      detailsReturn = undefined; reviewDetailsScroll = undefined;
      ticker.stop();
      clearInterval(activityTimer);
      clearTimeout(interactionNoticeTimer);
      renderer.keyInput.off("paste", onPaste);
      for (const state of durableDrafts.values()) clearTimeout(state.timer);
      unbindCredential();
      renderer.keyInput.off("keypress", onKey);
      renderer.off("selection", onSelection);
      renderer.off("theme_mode", onTheme);
      renderer.off("resize", refresh);
      renderer.off("frame", onFrame);
      root.destroyRecursively();
      syntax.destroy();
    },
  };
}
