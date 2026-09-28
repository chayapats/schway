import { PREFERENCE_SCOPES } from "./preferences.ts";
import { BoxRenderable, TextBufferRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, StyledText, fg, bold, getLinkId, type CliRenderer, type KeyEvent, type Selection } from "@opentui/core";
import { redactSecrets } from "../auth/secrets.ts";
import { bindCredentialInput } from "./credential-input.ts";
import { MAX_BRANCH_TREE_PREVIEW_ENTRIES, type TuiController, type TuiTranscriptEntry } from "./controller.ts";
import { activityDetail, activityStatus, displayText, fitLine } from "./presentation.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import { createTranscriptItem, markdownStyle, type TranscriptItemView } from "./transcript-view.ts";
import { browserUrl, textLinkAt } from "./links.ts";
import { renderedOffsetForFolded, TranscriptSearchIndex, type TranscriptSearchMatch, type TranscriptSearchResult } from "./search.ts";

/** Dependencies for the interactive presentation; submission remains owned by the application. */
export interface ConversationViewOptions {
  controller: TuiController;
  home: string;
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  secrets: string[];
  submit(value: string, accepted: () => void): Promise<unknown>;
  quit(): void;
  openUrl?(url: string): Promise<void>;
}

/** Build the conversation UI with stable messages, a multiline editor, and transient pickers. */
export function createConversationView(renderer: CliRenderer, options: ConversationViewOptions) {
  const controller = options.controller;
  let mode: ThemeMode = options.env.SCHWAY_THEME === "light" || options.env.SCHWAY_THEME === "dark" ? options.env.SCHWAY_THEME : "auto";
  let theme = resolveTheme(mode, renderer.themeMode, options.env);
  let syntax = markdownStyle(theme);
  let destroyed = false;
  let refreshing = false;
  let allExpanded = false;
  const expandedTools = new Set<string>();
  type InspectionTarget = { id: string; kind: "tool" | "code"; index: number };
  let inspection: InspectionTarget | undefined;
  let scrollToInspection = false;
  let searchOpen = false;
  let searchOriginalScroll = 0;
  let searchRestoreScroll: number | undefined;
  let searchScrollToMatch = false;
  let searchAcceptPending = false;
  let searchSelected = -1;
  let searchLastQuery = "";
  let searchResult: TranscriptSearchResult = { matches: [], limited: false };
  const searchIndex = new TranscriptSearchIndex();
  const rows = new Map<string, TranscriptItemView>();
  let sessionKey = "";
  let panelMode = "";
  let savedDraft = "";
  let savedDraftCursor = 0;
  let savedDraftRevision = 0;
  let panelFingerprint = "";
  let preferenceScrollToEnd = false;
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
  let discoveryOpen = false;
  let helpOriginalScroll = 0;
  let reviewOriginalScroll = 0;
  let reviewContent = "";
  let helpInserted = false;
  let lastQuery = "";
  let dismissedQuery: string | undefined;
  let unseen = false;
  let lastTail = "";
  let interactionNotice = "";
  let interactionNoticeUntil = 0;
  let paintedCancellationId: number | undefined;

  const root = new BoxRenderable(renderer, { id: "conversation", width: "100%", height: "100%", flexDirection: "column", paddingX: 2, backgroundColor: theme.background });
  renderer.root.add(root);
  const header = new TextRenderable(renderer, { id: "header", height: 1, flexShrink: 0, marginBottom: 1 });
  root.add(header);
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript", flexBasis: 0, flexGrow: 1, minHeight: 1, stickyScroll: true, stickyStart: "bottom", scrollX: false,
    contentOptions: { flexDirection: "column", paddingRight: 1 },
    verticalScrollbarOptions: { visible: false },
  });
  // ScrollBar initializes automatic visibility after its constructor options.
  // Set the override afterwards so overflow never changes the text's width.
  transcript.verticalScrollBar.visible = false;
  root.add(transcript);
  const empty = new TextRenderable(renderer, { content: "Start with a task. Type / to browse commands.", fg: theme.muted, marginTop: 1 });
  transcript.add(empty);
  const tree = new ScrollBoxRenderable(renderer, { id: "branch-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, scrollX: false, contentOptions: { flexDirection: "column" } });
  root.add(tree);
  const preferencePanel = new ScrollBoxRenderable(renderer, { id: "preferences-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, scrollX: false, contentOptions: { flexDirection: "column" } });
  root.add(preferencePanel);
  const reviewPanel = new ScrollBoxRenderable(renderer, { id: "change-review-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, scrollX: false, contentOptions: { flexDirection: "column" } });
  const reviewText = new TextRenderable(renderer, { id: "change-review-text", content: "", fg: theme.text, wrapMode: "word" });
  reviewPanel.add(reviewText);
  root.add(reviewPanel);
  const activity = new TextRenderable(renderer, { id: "activity", height: 1, flexShrink: 0, fg: theme.muted });
  root.add(activity);
  const picker = new BoxRenderable(renderer, { id: "picker", flexDirection: "column", flexShrink: 0, backgroundColor: theme.surface, paddingX: 1, visible: false });
  root.add(picker);
  const composer = new BoxRenderable(renderer, { id: "composer", flexDirection: "row", flexShrink: 0, border: ["top", "bottom"], borderColor: theme.border });
  root.add(composer);
  const promptMark = new TextRenderable(renderer, { content: "› ", fg: theme.accent, width: 2, flexShrink: 0 });
  composer.add(promptMark);
  const editor = new TextareaRenderable(renderer, {
    id: "prompt", flexGrow: 1, minHeight: 1, maxHeight: 6, wrapMode: "word",
    placeholder: "Ask Schway…", textColor: theme.text, focusedTextColor: theme.text,
    backgroundColor: theme.background, focusedBackgroundColor: theme.background,
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
  const footer = new TextRenderable(renderer, { id: "footer", height: 1, flexShrink: 0, fg: theme.muted });
  root.add(footer);
  const hints = new TextRenderable(renderer, { id: "hints", height: 1, flexShrink: 0, fg: theme.muted });
  root.add(hints);

  // Like a primary ScrollView, non-scrollable chrome routes wheel input to the
  // conversation. Preserve native handling over a scroller or multiline editor.
  root.onMouseScroll = event => {
    for (let target = event.target; target && target !== root; target = target.parent) {
      if (target instanceof ScrollBoxRenderable || target === editor) return;
    }
    event.stopPropagation();
    (controller.snapshot().changeReview ? reviewPanel : controller.snapshot().preferences ? preferencePanel : controller.snapshot().branchTree ? tree : transcript).processMouseEvent(event);
  };

  const showInteractionNotice = (text: string) => {
    interactionNotice = text;
    interactionNoticeUntil = Date.now() + 2500;
    refresh();
  };
  const copySelection = () => {
    if (controller.snapshot().credentialEntry) return false;
    const text = renderer.getSelection()?.getSelectedText();
    if (!text) return false;
    const copied = renderer.copyToClipboardOSC52(safe(text));
    showInteractionNotice(copied ? "Copied selection" : "Clipboard unavailable · use the terminal's native selection");
    return true;
  };
  const inspectionTargets = (entries: readonly TuiTranscriptEntry[]): InspectionTarget[] => entries.flatMap<InspectionTarget>(entry =>
    entry.kind === "tool" ? [{ id: entry.id, kind: "tool" as const, index: 0 }]
      : entry.kind === "assistant" ? (rows.get(entry.id)?.codeBlocks() ?? []).map((_, index) => ({ id: entry.id, kind: "code" as const, index })) : []);
  const copyInspection = (entries: readonly TuiTranscriptEntry[]) => {
    if (!inspection) return;
    const entry = entries.find(item => item.id === inspection!.id);
    if (!entry) return;
    const text = inspection.kind === "tool" ? safe(entry.text) : rows.get(entry.id)?.codeBlocks()[inspection.index]?.text;
    if (text === undefined) return;
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(text); } catch { /* Clipboard support is optional. */ }
    const bounded = inspection.kind === "tool" && text.endsWith("… truncated. Full output is in the session file.");
    showInteractionNotice(copied ? bounded ? "Copied bounded result preview · full output is in the session file" : inspection.kind === "tool" ? "Copied displayed result" : "Copied displayed code without Markdown fences" : "Clipboard unavailable · select text in the terminal");
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
  const textRow = (box: BoxRenderable, text: string, color = theme.text) => {
    const row = new TextRenderable(renderer, { content: safe(text), fg: color, flexShrink: 0, wrapMode: "word" });
    box.add(row);
    return row;
  };
  const resetRows = () => {
    for (const row of rows.values()) row.root.destroyRecursively();
    rows.clear();
  };

  function completions() {
    if (panelMode && panelMode !== "help" || editor.plainText === dismissedQuery) return [];
    return controller.commandChoices(editor.plainText, panelMode === "help" && !helpInserted);
  }

  function refreshDiscovery() {
    // Explicit dispatch already refreshes metadata; its own repaint must not supersede it.
    if (pendingAcceptance) return;
    void controller.refreshCommands().then(() => { if (!destroyed) refresh(); }, () => {});
  }

  function applyTheme() {
    theme = resolveTheme(mode, renderer.themeMode, options.env);
    resetRows();
    clear(tree);
    clear(picker);
    syntax.destroy();
    syntax = markdownStyle(theme);
    root.backgroundColor = theme.background;
    renderer.setBackgroundColor(theme.background);
    picker.backgroundColor = theme.surface;
    composer.borderColor = theme.border;
    editor.textColor = editor.focusedTextColor = theme.text;
    editor.backgroundColor = editor.focusedBackgroundColor = theme.background;
    editor.placeholderColor = theme.muted;
    editor.cursorColor = promptMark.fg = theme.accent;
    editor.selectionBg = theme.border;
    credential.fg = reviewText.fg = theme.text;
    hints.fg = footer.fg = empty.fg = theme.muted;
    panelFingerprint = "";
    refresh();
  }

  function refresh() {
    if (destroyed || refreshing) return;
    refreshing = true;
    try {
      const snapshot = controller.snapshot();
      // Startup readiness is transient chrome; recovery details remain available on demand.
      const entries = snapshot.readiness !== "ready" && snapshot.transcript.length === 1 && !snapshot.recovery?.accepted && snapshot.transcript[0]?.id === snapshot.recovery?.entryId ? [] : snapshot.transcript;
      paintedCancellationId = snapshot.activity?.cancellation === "requested" ? snapshot.activity.operationId : undefined;
      const width = Math.max(8, renderer.width - (renderer.width < 60 ? 2 : 4));
      root.paddingX = renderer.width < 60 ? 1 : 2;
      header.visible = activity.visible = renderer.height >= 10;
      hints.visible = renderer.height >= 14;
      header.marginBottom = renderer.height < 20 ? 0 : 1;
      const key = `${snapshot.sessionId}/${snapshot.branchId}`;
      if (sessionKey !== key) {
        discoveryOpen = false; completionId = undefined;
        resetRows(); sessionKey = key; expandedTools.clear(); inspection = undefined; unseen = false; lastTail = "";
        searchOpen = false; searchSelected = -1; searchLastQuery = "";
        searchRestoreScroll = undefined; searchScrollToMatch = false; searchAcceptPending = false;
        searchIndex.clear();
        latest();
      }
      const externalPanel = snapshot.credentialEntry ? "credential" : snapshot.loginCallbackEntry ? "callback" : snapshot.loginChooser ? "login" : snapshot.loginApproval ? "approval" : snapshot.modelPicker ? "model" : snapshot.preferences ? "preferences" : snapshot.branchTree ? "tree" : snapshot.changeReview ? "review" : "";
      if (externalPanel || searchOpen) controller.commandHelpOpen = false;
      if (searchOpen && externalPanel) { searchOpen = false; searchScrollToMatch = false; searchAcceptPending = false; searchIndex.clear(); }
      const nextPanel = externalPanel || (searchOpen ? "search" : controller.commandHelpOpen ? "help" : "");
      if (nextPanel !== panelMode) {
        if (!panelMode && nextPanel) { savedDraft = editor.plainText; savedDraftCursor = editor.cursorOffset; savedDraftRevision = editorRevision; }
        if (nextPanel === "review") { reviewOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (panelMode === "review" && !nextPanel) searchRestoreScroll = reviewOriginalScroll;
        if (nextPanel === "help") { helpInserted = false; helpOriginalScroll = transcript.scrollTop; transcript.stickyScroll = false; }
        if (panelMode === "help" && !nextPanel) searchRestoreScroll = helpOriginalScroll;
        panelMode = nextPanel;
        setDraft(panelMode === "model" ? snapshot.modelPicker?.query ?? "" : panelMode ? "" : savedDraft);
        if (!panelMode) editor.cursorOffset = savedDraftCursor;
        panelFingerprint = "";
      }
      editor.visible = !snapshot.changeReview && !snapshot.credentialEntry && !snapshot.loginCallbackEntry && !snapshot.loginApproval;
      credential.visible = !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval;
      if (snapshot.changeReview) { editor.blur(); }
      else if (snapshot.credentialEntry || snapshot.loginCallbackEntry || snapshot.loginApproval) {
        editor.blur();
        credential.content = snapshot.credentialEntry
          ? safe(`API key · ${snapshot.credentialEntry.label}\n${snapshot.credentialEntry.masked || "Enter key…"}\nEnter saves · Esc cancels`)
          : snapshot.loginCallbackEntry
            ? safe(`Browser callback · ${snapshot.loginCallbackEntry.masked || "Paste redirect URL or code…"} · Enter exchanges · Esc cancels`)
            : "Approval pending · Esc cancels";
      } else if ((!inspection || searchOpen) && !editor.focused) editor.focus();
      editor.placeholder = panelMode === "model" ? "Search models or type provider/model…" : panelMode === "tree" ? "Optional fork name…" : panelMode === "help" ? "Search commands, skills, sources…" : panelMode === "search" ? "Find in this conversation…" : "Ask Schway…";
      const workspace = controller.workspaceIdentity();
      let path = workspace?.root ?? options.workspaceRoot;
      if (path === options.home || path.startsWith(`${options.home}/`)) path = `~${path.slice(options.home.length)}`;
      header.content = new StyledText([bold(fg(theme.accent)("schway")), fg(theme.muted)(`  ${fitLine(safe(path), width - 8)}`)]);
      const status = snapshot.readiness === "loading" ? "Checking connection" : snapshot.activity ? activityStatus(snapshot.activity, width < 60, width < 32) : snapshot.status === "running" ? "● Working · Esc stops" : snapshot.status === "error" ? "! Needs attention" : "Ready";
      const model = safe(`${snapshot.activeRoute ? `${snapshot.activeRoute} · ` : ""}${snapshot.provider}/${snapshot.modelId}${snapshot.thinking ? ` · ${snapshot.thinking}` : ""}${snapshot.profile ? ` · ${snapshot.profile}` : ""}`);
      const statusWidth = Bun.stringWidth(status);
      footer.content = new StyledText([
        fg(theme.muted)(`${fitLine(model, Math.max(0, width - statusWidth - 3))}${width > statusWidth + 3 ? "   " : ""}`),
        fg(snapshot.activity?.phase === "stopping" ? theme.warning : snapshot.status === "error" ? theme.error : snapshot.status === "running" ? theme.accent : theme.muted)(fitLine(status, width)),
      ]);
      const tail = entries.at(-1);
      const tailKey = `${tail?.id}:${tail?.text.length}:${tail?.toolStatus}`;
      if (lastTail && lastTail !== tailKey && !atBottom()) unseen = true;
      lastTail = tailKey;
      if (atBottom()) unseen = false;
      transcript.visible = !snapshot.branchTree && !snapshot.preferences && !snapshot.changeReview;
      reviewPanel.visible = !!snapshot.changeReview;
      if (snapshot.changeReview) {
        const review = snapshot.changeReview;
        const content = safe(`${review.heading}\n\n${review.files.map((file, i) => `${i === review.selected ? "›" : " "} ${file.staged}${file.unstaged} ${file.origPath ? `${file.origPath} → ` : ""}${file.path}${file.binary ? " [binary]" : ""}`).join("\n")}\n\n${review.detail}`);
        if (content !== reviewContent) { reviewText.content = content; reviewContent = content; }
      }
      preferencePanel.visible = !!snapshot.preferences;
      tree.visible = !!snapshot.branchTree;
      empty.visible = entries.length === 0;
      const route = snapshot.activeRoute ?? (snapshot.provider === "openai-compatible" ? `Compatible endpoint${snapshot.profile ? ` · profile:${snapshot.profile}` : ""}` : `${snapshot.provider} API key`);
      const action = snapshot.readiness === "loading" ? "Checking selected connection… You can type while waiting · Esc cancels"
        : snapshot.readiness === "ready" ? "Type a task · Enter sends"
        : snapshot.readiness === "connect" ? "Connect to get started · Alt+L"
        : snapshot.readiness === "choose-model" ? "Choose an available model · Alt+M"
        : snapshot.recovery?.category === "credential-store" ? "Repair connection: unlock OS credential storage · Ctrl+R retry"
        : "Repair connection: choose model/settings · Alt+M";
      empty.content = safe(`${path}\n${snapshot.provider}/${snapshot.modelId} · ${route}${snapshot.readiness === "ready" && snapshot.activeRoute !== "ChatGPT subscription" ? " · configured, unverified" : ""}\n\n${snapshot.readinessDetail ? `${snapshot.readinessDetail}\n` : ""}${action}${snapshot.readiness !== "ready" && snapshot.readiness !== "loading" ? "\nCtrl+I failure details · Your task stays in the editor" : ""}`);
      const ids = new Set(entries.map(entry => entry.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.root.destroyRecursively(); rows.delete(id); }
      for (const entry of entries) {
        let row = rows.get(entry.id);
        if (!row) {
          row = createTranscriptItem(renderer, entry, theme, syntax, () => {
            if (expandedTools.has(entry.id)) expandedTools.delete(entry.id); else expandedTools.add(entry.id);
            refresh();
          });
          rows.set(entry.id, row);
          transcript.add(row.root);
        }
        row.update({ ...entry, text: safe(entry.text), toolName: entry.toolName ? safe(entry.toolName) : undefined, toolSummary: entry.toolSummary ? safe(entry.toolSummary) : undefined }, allExpanded !== expandedTools.has(entry.id), snapshot.status === "running" && entry === tail, width - 1,
          inspection?.id === entry.id && inspection.kind === "code" ? inspection.index : undefined,
          inspection?.id === entry.id && inspection.kind === "tool");
      }
      if (inspection && !inspectionTargets(entries).some(target => target.id === inspection!.id && target.kind === inspection!.kind && target.index === inspection!.index)) {
        inspection = undefined;
        if (!panelMode) editor.focus();
      }
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
      const searchStatus = !editor.plainText ? "Find in active branch · type a literal query" : searchResult.matches.length
        ? `Find ${searchSelected + 1}/${searchResult.matches.length}${searchResult.limited ? "+ (limited)" : ""} · active branch, displayed text`
        : `No matches${searchResult.limited ? " in searched portion" : ""} · active branch, displayed text`;
      if (searchOpen && !activity.visible) footer.content = fitLine(searchStatus, width);
      const completed = snapshot.outcome;
      const observed = completed?.commands.filter(c => c.exitCode !== null) ?? [];
      const nonzero = observed.filter(c => c.exitCode !== 0).length;
      const outcomeText = completed ? width < 65 ? `Turn ${completed.reason} · Alt+R review · ${nonzero} nonzero exits` : `Turn ${completed.reason} · commands: ${observed.length - nonzero} exit 0 / ${nonzero} nonzero / ${completed.commands.length - observed.length} unknown · Alt+R review` : "";
      activity.content = fitLine(snapshot.activity?.phase === "stopping" ? activityDetail(snapshot.activity) : searchOpen ? searchStatus : Date.now() < interactionNoticeUntil ? interactionNotice : unseen ? "↓ New activity · Ctrl+End to return to latest" : snapshot.branchTreeError ? safe(snapshot.branchTreeError) : snapshot.activity ? activityDetail(snapshot.activity) : snapshot.status === "running" ? "Working on your request…" : outcomeText, width);
      activity.fg = snapshot.activity?.phase === "stopping" ? theme.warning : searchOpen ? theme.accent : unseen ? theme.accent : snapshot.branchTreeError ? theme.error : theme.muted;
      activity.onMouseUp = () => { if (!searchOpen) { latest(); refresh(); } };

      const browsing = panelMode === "help" || (!panelMode && editor.plainText.startsWith("/") && editor.plainText !== dismissedQuery);
      if (browsing && !discoveryOpen) refreshDiscovery();
      discoveryOpen = browsing;
      const available = completions();
      if (editor.plainText !== lastQuery) { completionIndex = 0; completionId = available[0]?.id; lastQuery = editor.plainText; }
      else if (completionId) completionIndex = available.findIndex(entry => entry.id === completionId && entry.available);
      else completionIndex = -1;
      picker.visible = !!snapshot.loginChooser || !!snapshot.loginApproval || !!snapshot.modelPicker || browsing;
      const maxRows = Math.max(1, Math.min(6, Math.floor(renderer.height / 3) - 2));
      const deviceApproval = snapshot.loginApproval ? /^Enter this code at (.*?): (.+)$/.exec(snapshot.loginApproval) : null;
      const approvalRows = deviceApproval
        ? (renderer.height >= 12 ? 1 : 0) + Math.ceil(Bun.stringWidth(deviceApproval[2]!)/(width - 2)) + Math.ceil(Bun.stringWidth(deviceApproval[1]!)/(width - 2))
        : 2;
      const pickerRows = snapshot.loginChooser ? Math.min(maxRows, snapshot.loginChooser.choices.length) + 1 : snapshot.loginApproval ? approvalRows : snapshot.modelPicker ? Math.min(maxRows, snapshot.modelPicker.entries.length) + 2 : Math.max(1, Math.min(maxRows, available.length));
      const chromeRows = (header.visible ? 1 + (renderer.height >= 20 ? 1 : 0) : 0) + (activity.visible ? 1 : 0) + (hints.visible ? 1 : 0) + 3;
      // Reserve the transcript, composer borders, status and picker before
      // allowing the editor to grow. A wrapping placeholder also consumes rows.
      editor.maxHeight = searchOpen ? 1 : Math.max(1, Math.min(6, Math.floor(renderer.height / 4), renderer.height - chromeRows - pickerRows - 1));
      const panelKey = JSON.stringify([snapshot.preferences, snapshot.loginChooser, snapshot.loginApproval, snapshot.modelPicker, snapshot.branchTree, available, completionIndex, width, renderer.height]);
      if (panelKey !== panelFingerprint) {
        panelFingerprint = panelKey;
        clear(picker);
        clear(preferencePanel);
        if (snapshot.preferences) {
          const panel = snapshot.preferences;
          const row = panel.rows[panel.selectedIndex]!;
          const choice = row.choices[panel.choiceIndex];
          const lines = [
            `Preferences · ${panel.scope} · ${panel.selectedIndex + 1}/${panel.rows.length}`,
            "↑/↓ field · ←/→ choice · Tab scope",
            "Enter preview/confirm · Esc back · PgUp/PgDn scroll",
            PREFERENCE_SCOPES[panel.scope],
            `${row.key}: ${row.value} [${row.origin}]`,
            `Saved: ${row.saved}`,
            row.reset,
            `Choice: ${choice === undefined ? "Reset (inherit)" : String(choice)} (${panel.choiceIndex + 1}/${row.choices.length})`,
            panel.error ?? panel.preview ?? "Enter previews; no changes yet.",
          ];
          // Wrap details, including scope/confirmation, instead of silently clipping at narrow widths.
          for (const line of lines) textRow(preferencePanel, safe(line), theme.text).wrapMode = "word";
          if (panel.preview || panel.error) preferenceScrollToEnd = true;
          else preferencePanel.scrollTo(0);
        } else if (snapshot.loginChooser) {
          textRow(picker, fitLine("Sign in · ↑/↓ select · Enter continue · Esc back", width - 2), theme.accent);
          const choices = snapshot.loginChooser.choices;
          const start = Math.max(0, Math.min(snapshot.loginChooser.selectedIndex - Math.floor(maxRows / 2), choices.length - maxRows));
          choices.slice(start, start + maxRows).forEach((choice, offset) => {
            const index = start + offset;
            textRow(picker, fitLine(`${index === snapshot.loginChooser!.selectedIndex ? "›" : " "} ${choice}`, width - 2), index === snapshot.loginChooser!.selectedIndex ? theme.accent : theme.text);
          });
        } else if (snapshot.loginApproval) {
          if (renderer.height >= 12) textRow(picker, "Complete ChatGPT approval · Esc cancels", theme.accent);
          if (deviceApproval) {
            textRow(picker, deviceApproval[2]!, theme.accent).wrapMode = "char";
            textRow(picker, deviceApproval[1]!, theme.text).wrapMode = "char";
          } else textRow(picker, snapshot.loginApproval, theme.text).wrapMode = "char";
        } else if (snapshot.modelPicker) {
          const models = snapshot.modelPicker;
          textRow(picker, fitLine("Choose model + route · ↑/↓ select · Enter apply/connect · Ctrl+R retry · Esc back", width - 2), theme.accent);
          const start = Math.max(0, Math.min(models.selectedIndex - Math.floor(maxRows / 2), models.entries.length - maxRows));
          models.entries.slice(start, start + maxRows).forEach((entry, offset) => {
            const index = start + offset;
            const route = entry.authRoute === "codex" ? "ChatGPT" : entry.authRoute === "api-key" ? "API key" : entry.access ?? "Provider";
            const name = entry.connect ? "Connect ChatGPT" : entry.profile ? `profile:${entry.profile}` : `${entry.provider}/${entry.modelId}`;
            textRow(picker, fitLine(`${index === models.selectedIndex ? "›" : " "} ${route} · ${name}${entry.active ? " ✓ current" : ""}${entry.access === "Login required" ? " · Connect" : ""}${entry.custom ? " (typed)" : ""}`, width - 2), index === models.selectedIndex ? theme.accent : theme.text);
          });
          const selected = models.entries[models.selectedIndex];
          const routeDetail = selected?.connect ? "ChatGPT subscription · connect to discover models"
            : selected?.authRoute === "codex" ? `ChatGPT subscription · ${selected.verifiedCatalog ? "account catalog" : "catalog pending"}`
              : `${selected?.authRoute === "api-key" ? "OpenAI API key" : selected?.access ?? "Provider"} · ${selected?.access === "Login required" ? "connect needed" : selected?.access === "No key required" ? "no key required" : "configured, unverified"}`;
          const detail = selected ? `${routeDetail} · ${models.selectedIndex + 1}/${models.entries.length}${selected.connect ? "" : ` · ${selected.contextWindow.toLocaleString()} context · ${selected.maxOutput.toLocaleString()} output`}` : "No matches. Try provider/model-id.";
          textRow(picker, fitLine(models.error ?? (models.loading ? `Loading ChatGPT catalog… ${detail}` : detail), width - 2), models.error ? theme.error : theme.muted);
        } else if (browsing) {
          const start = Math.max(0, completionIndex - maxRows + 1);
          if (!available.length) textRow(picker, "No matches · Esc dismiss", theme.muted);
          available.slice(start, start + maxRows).forEach((entry, offset) => {
            textRow(picker, fitLine(`${start + offset === completionIndex ? "›" : " "} ${entry.available ? "" : "! "}[${entry.source.startsWith("extension ") ? "extension" : entry.source}] /${entry.name} ${entry.description}`, width - 2), start + offset === completionIndex ? theme.accent : theme.muted);
          });
        }
        if (snapshot.branchTree) {
          clear(tree);
          const branches = snapshot.branchTree;
          textRow(tree, "Conversation branches · ↑/↓ browse · Enter switch/fork · Esc back", theme.accent);
          textRow(tree, `Active: ${branches.activeBranchId}`, theme.muted);
          for (const node of branches.nodes) {
            const selected = node.id === branches.selectedId;
            const branchRow = textRow(tree, fitLine(`${selected ? "›" : " "} ${"  ".repeat(Math.min(node.depth, 6))}${node.isActiveHead ? "● " : ""}${node.kind} · ${node.preview}`, width), selected ? theme.accent : theme.text);
            branchRow.id = `branch-${node.id}`;
          }
          if (branches.truncated) textRow(tree, `Showing ${branches.nodes.length}/${branches.totalNodeCount} entries · /branch list for IDs`, theme.warning);
          const previewKey = `${key}/${branches.selectedId}/${branches.totalNodeCount}`;
          if (previewKey !== treePreviewKey) {
            treePreviewKey = previewKey;
            try { treePreview = controller.previewBranchTreeNode(branches.selectedId).slice(-MAX_BRANCH_TREE_PREVIEW_ENTRIES); }
            catch { treePreview = [{ id: "error", kind: "error", text: "Preview unavailable. Reopen /branch tree to retry." }]; }
          }
          textRow(tree, "\nPreview", theme.accent);
          textRow(tree, treePreview.map(entry => `${entry.kind}: ${entry.text}`).join("\n\n") || "Empty conversation", theme.muted);
          tree.scrollChildIntoView(`branch-${branches.selectedId}`);
        }
      }
      hints.content = fitLine(panelMode === "review" ? "↑↓ files · PgUp/PgDn scroll · Esc return to draft" : panelMode === "help" ? helpInserted ? "Enter use · Tab complete · Esc restore" : "↑↓ select · Tab preview · Esc restore" : searchOpen ? "↑/↓ next/previous · Enter accept · Esc restore · Ctrl+End latest" : panelMode ? "Enter confirm · Esc back" : inspection ? inspection.kind === "tool" ? "↑↓ move · Enter toggle · C copy · Esc" : "↑↓ move · C copy · Esc editor" : available.length ? "↑/↓ select · Tab complete · Esc dismiss · Enter send" : renderer.width < 70 ? "Enter send · Ctrl+F find · Alt+I inspect" : "Enter send · Ctrl+F find · Alt+I inspect · Ctrl+O tools · / commands", width);
    } finally { refreshing = false; }
  }

  function submit() {
    if (panelMode === "help") {
      if (helpInserted) { const command = editor.plainText; controller.commandHelpOpen = false; refresh(); setDraft(command); refresh(); }
      return;
    }
    if (searchOpen) {
      if (searchScrollToMatch && searchResult.matches[searchSelected]) searchAcceptPending = true;
      else closeSearch(false);
      return;
    }
    const snapshot = controller.snapshot();
    if (snapshot.changeReview) return;
    if (snapshot.readiness === "loading" || snapshot.credentialEntry || snapshot.loginCallbackEntry) return;
    if (snapshot.loginChooser) {
      void controller.selectLoginChoice().then(refresh, fail);
      return;
    }
    if (snapshot.preferences) {
      void controller.selectPreference().then(refresh, fail);
      return;
    }
    if (snapshot.modelPicker) {
      void controller.selectPickerModel().then(refresh, fail);
      return;
    }
    if (snapshot.branchTree && !editor.plainText.trim().startsWith("/")) {
      controller.confirmBranchTreeSelection(editor.plainText.trim() || undefined);
      refresh(); return;
    }
    const value = editor.plainText;
    if (!value.trim()) return;
    if (pendingAcceptance) return;
    if (observedDraft !== value) { observedDraft = value; editorRevision++; }
    const revision = editorRevision;
    const accept = () => {
      pendingAcceptance = false;
      // Credential callback commands must never enter prompt recall.
      if (!value.trimStart().startsWith("/") && history.at(-1) !== value) {
        history.push(value); if (history.length > 100) history.shift();
      }
      historyIndex = -1;
      if (panelMode) {
        if (savedDraftRevision === revision && savedDraft === value) { savedDraft = ""; savedDraftCursor = 0; }
      } else if (editorRevision === revision && editor.plainText === value) {
        setDraft("");
      }
      dismissedQuery = undefined;
      latest();
      refresh();
    };
    if (controller.running && /^\/(theme|session)(?:\s|$)/.test(value.trim())) { controller.notice("Already running. Press Esc to cancel first."); return; }
    if (/^\/(theme|session)(?:\s|$)/.test(value.trim())) {
      pendingAcceptance = true;
      void controller.commandCollision(value.trim().split(/\s/)[0]!.slice(1)).then(collides => {
        pendingAcceptance = false;
        if (collides || editorRevision !== revision) { refresh(); return; }
        if (controller.running) { controller.notice("Already running. Press Esc to cancel first."); refresh(); return; }
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
        else { mode = requested as ThemeMode; applyTheme(); accept(); }
        refresh(); return;
      }
      if (value.trim() === "/session") {
        const workspace = controller.workspaceIdentity();
        controller.notice(`Session: ${snapshot.sessionId}\nConversation branch: ${snapshot.branchId}\nModel: ${snapshot.provider}/${snapshot.modelId}\nPrimary: ${workspace?.root ?? options.workspaceRoot}\nAttached: ${workspace?.extraRoots.join(", ") || "none"}`);
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

  function onKey(key: KeyEvent) {
    if (key.defaultPrevented || key.eventType === "release" || controller.snapshot().credentialEntry || controller.snapshot().loginCallbackEntry) return;
    const name = key.name.toLowerCase();
    const snapshot = controller.snapshot();
    const handled = () => { key.preventDefault(); key.stopPropagation(); refresh(); };
    if (snapshot.changeReview) {
      if (name === "escape") { controller.closeChangeReview(); handled(); return; }
      if (name === "up" || name === "down") { void controller.selectReviewFile(name === "up" ? -1 : 1).then(refresh, fail); reviewPanel.scrollTo(0); }
      if (name === "pageup" || name === "pagedown") reviewPanel.scrollBy(name === "pageup" ? -Math.max(1, renderer.height - 8) : Math.max(1, renderer.height - 8));
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
    if (panelMode === "help" && ((key.meta || key.option) || key.ctrl && !["c", "a", "e", "u", "k", "w"].includes(name))) { handled(); return; }
    if (snapshot.recovery && !panelMode && !controller.running && !snapshot.modelPicker && !snapshot.loginChooser && !snapshot.preferences) {
      if (key.ctrl && name === "r" && snapshot.recovery.actions.includes("retry-credentials")) {
        void controller.retryCredentialRecovery().then(refresh, fail); handled(); return;
      }
      if (key.ctrl && name === "r" && snapshot.recovery.actions.includes("continue")) {
        void controller.continueRecovery().then(refresh, fail); handled(); return;
      }
      if (key.ctrl && name === "i" && snapshot.recovery.actions.includes("details")) {
        controller.inspectRecovery(); handled(); return;
      }
      if ((key.meta || key.option) && name === "l" && snapshot.recovery.actions.includes("connect")) {
        controller.openRecoveryRepair("connect"); handled(); return;
      }
      if ((key.meta || key.option) && name === "m" && snapshot.recovery.actions.includes("choose-model")) {
        controller.openRecoveryRepair("choose-model"); handled(); return;
      }
      if (name === "escape" && snapshot.recovery.actions.includes("keep-editing")) {
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
        inspection = undefined; editor.focus(); handled(); return;
      }
      if (name === "up" || name === "down" || name === "tab") {
        const delta = name === "up" || (name === "tab" && key.shift) ? -1 : 1;
        inspection = targets[Math.max(0, Math.min(targets.length - 1, current + delta))];
        scrollToInspection = true; handled(); return;
      }
      if (name === "return" || name === "kpenter") {
        if (inspection.kind === "tool") {
          if (expandedTools.has(inspection.id)) expandedTools.delete(inspection.id); else expandedTools.add(inspection.id);
          scrollToInspection = true;
        } else copyInspection(snapshot.transcript);
        handled(); return;
      }
      if (key.ctrl && name === "c" && controller.running) { controller.cancel(); handled(); return; }
      if (name === "c") { copyInspection(snapshot.transcript); handled(); return; }
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
      else if (!snapshot.preferences) showInteractionNotice("Close the current panel with Esc before opening preferences.");
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
      inspection = inspectionTargets(snapshot.transcript)[0];
      if (inspection) { editor.blur(); scrollToInspection = true; }
      else showInteractionNotice("No tool results or code blocks to inspect");
      handled(); return;
    }
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
      else if (snapshot.modelPicker) controller.closeModelPicker();
      else if (snapshot.branchTree) controller.closeBranchTree();
      else if (discoveryOpen) dismissedQuery = editor.plainText;
      else if (controller.running) controller.cancel();
      handled(); return;
    }
    if (key.ctrl && name === "c") { if (controller.running) controller.cancel(); else options.quit(); handled(); return; }
    if (key.ctrl && name === "d" && !editor.plainText) { options.quit(); handled(); return; }
    if (name === "up" || name === "down") {
      const delta = name === "up" ? -1 : 1;
      if (snapshot.loginChooser) { controller.moveLoginChooser(delta); handled(); return; }
      if (snapshot.modelPicker) { controller.moveModelPicker(delta); handled(); return; }
      if (snapshot.branchTree) { controller.moveBranchTreeSelection(delta); handled(); return; }
      const choices = completions();
      if (choices.length) { completionIndex = (completionIndex + delta + choices.length) % choices.length; completionId = choices[completionIndex]?.id; handled(); return; }
      if (panelMode === "help") { handled(); return; }
      if (!key.shift && !key.ctrl && !key.meta && history.length && (name === "up" ? editor.visualCursor.visualRow === 0 : editor.visualCursor.visualRow >= editor.virtualLineCount - 1)) {
        if (historyIndex === -1 && name === "down") return;
        if (historyIndex === -1) { historyDraft = editor.plainText; historyIndex = history.length; }
        historyIndex = Math.max(0, Math.min(history.length, historyIndex + delta));
        setDraft(historyIndex === history.length ? historyDraft : history[historyIndex]!);
        if (historyIndex === history.length) historyIndex = -1;
        handled(); return;
      }
    }
    if (name === "tab" && !key.shift) {
      const selected = completions()[completionIndex];
      if (selected?.available) {
        if (panelMode === "help") helpInserted = true;
        setDraft(selected.insertion); handled();
      }
    }
  }

  editor.onSubmit = submit;
  editor.onContentChange = () => {
    if (refreshing || destroyed) return;
    if (observedDraft !== editor.plainText) { observedDraft = editor.plainText; editorRevision++; }
    if (controller.snapshot().modelPicker) controller.searchModels(editor.plainText);
    refresh();
  };
  renderer.keyInput.on("keypress", onKey);
  renderer.on("selection", onSelection);
  const unbindCredential = bindCredentialInput(renderer.keyInput, controller, refresh);
  const onTheme = () => { if (mode === "auto") applyTheme(); };
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
    if (preferenceScrollToEnd) { preferenceScrollToEnd = false; preferencePanel.scrollTo(preferencePanel.scrollHeight); }
    if (searchRestoreScroll !== undefined) {
      transcript.scrollTo(searchRestoreScroll);
      searchRestoreScroll = undefined;
    }
    if (searchOpen && searchScrollToMatch) {
      searchScrollToMatch = false;
      const match = searchResult.matches[searchSelected];
      if (match) scrollToSearchMatch(match);
    }
    if (searchOpen && searchAcceptPending) closeSearch(false);
    if (scrollToInspection && inspection) {
      scrollToInspection = false;
      transcript.scrollChildIntoView(inspection.kind === "tool" ? `message-${inspection.id}` : `code-${inspection.id}-${inspection.index}`);
    }
    if (paintedCancellationId === undefined) return;
    controller.acknowledgeCancellationFrame(paintedCancellationId);
    paintedCancellationId = undefined;
  };
  renderer.on("frame", onFrame);
  renderer.setBackgroundColor(theme.background);
  editor.focus();
  const activityTimer = setInterval(() => { if (!destroyed && controller.snapshot().activity) refresh(); }, 250);
  refresh();
  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(activityTimer);
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
