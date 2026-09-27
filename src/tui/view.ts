import { BoxRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, StyledText, fg, bold, getLinkId, type CliRenderer, type KeyEvent, type Selection } from "@opentui/core";
import { redactSecrets } from "../auth/secrets.ts";
import { bindCredentialInput } from "./credential-input.ts";
import { MAX_BRANCH_TREE_PREVIEW_ENTRIES, type TuiController, type TuiTranscriptEntry } from "./controller.ts";
import { displayText, fitLine } from "./presentation.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import { createTranscriptItem, markdownStyle, type TranscriptItemView } from "./transcript-view.ts";
import { browserUrl, textLinkAt } from "./links.ts";

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

const COMMANDS: Record<string, string> = {
  model: "Choose model or profile", thinking: "Set reasoning level", theme: "auto / dark / light",
  session: "Show session and workspace details", new: "Start a session", sessions: "List saved sessions",
  resume: "Resume a saved session", branch: "Browse or fork conversation branches", changes: "Inspect Git changes",
  compact: "Summarize older context", skills: "List available skills", "add-dir": "Attach a workspace",
  config: "Show or change settings", login: "Sign in", logout: "Remove a credential", help: "Commands and shortcuts", quit: "Exit Schway",
};

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
  const rows = new Map<string, TranscriptItemView>();
  let sessionKey = "";
  let panelMode = "";
  let savedDraft = "";
  let savedDraftCursor = 0;
  let panelFingerprint = "";
  let treePreviewKey = "";
  let treePreview: readonly TuiTranscriptEntry[] = [];
  let historyIndex = -1;
  let historyDraft = "";
  const history: string[] = [];
  let completionIndex = 0;
  let lastQuery = "";
  let dismissedQuery: string | undefined;
  let unseen = false;
  let lastTail = "";
  let interactionNotice = "";
  let interactionNoticeUntil = 0;

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
    (controller.snapshot().branchTree ? tree : transcript).processMouseEvent(event);
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
  const latest = () => { transcript.scrollTo(transcript.scrollHeight); unseen = false; };
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
    if (panelMode || !/^\/[^\s]*$/.test(editor.plainText) || editor.plainText === dismissedQuery) return [];
    const query = editor.plainText.slice(1).toLowerCase();
    const commands = new Map(Object.entries(COMMANDS));
    for (const command of controller.extensionCommands()) commands.set(command.name, command.description);
    return [...commands].filter(([name]) => name.toLowerCase().startsWith(query));
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
    credential.fg = theme.text;
    hints.fg = footer.fg = empty.fg = theme.muted;
    panelFingerprint = "";
    refresh();
  }

  function refresh() {
    if (destroyed || refreshing) return;
    refreshing = true;
    try {
      const snapshot = controller.snapshot();
      const width = Math.max(8, renderer.width - (renderer.width < 60 ? 2 : 4));
      root.paddingX = renderer.width < 60 ? 1 : 2;
      header.visible = activity.visible = renderer.height >= 10;
      hints.visible = renderer.height >= 14;
      header.marginBottom = renderer.height < 20 ? 0 : 1;
      const key = `${snapshot.sessionId}/${snapshot.branchId}`;
      if (sessionKey !== key) {
        resetRows(); sessionKey = key; expandedTools.clear(); unseen = false; lastTail = "";
        latest();
      }
      const nextPanel = snapshot.credentialEntry ? "credential" : snapshot.loginCallbackEntry ? "callback" : snapshot.loginChooser ? "login" : snapshot.loginApproval ? "approval" : snapshot.modelPicker ? "model" : snapshot.branchTree ? "tree" : "";
      if (nextPanel !== panelMode) {
        if (!panelMode && nextPanel) { savedDraft = editor.plainText; savedDraftCursor = editor.cursorOffset; }
        panelMode = nextPanel;
        setDraft(panelMode ? "" : savedDraft);
        if (!panelMode) editor.cursorOffset = savedDraftCursor;
        panelFingerprint = "";
      }
      editor.visible = !snapshot.credentialEntry && !snapshot.loginCallbackEntry && !snapshot.loginApproval;
      credential.visible = !!snapshot.credentialEntry || !!snapshot.loginCallbackEntry || !!snapshot.loginApproval;
      if (snapshot.credentialEntry || snapshot.loginCallbackEntry || snapshot.loginApproval) {
        editor.blur();
        credential.content = snapshot.credentialEntry
          ? safe(`API key · ${snapshot.credentialEntry.label}\n${snapshot.credentialEntry.masked || "Enter key…"}\nEnter saves · Esc cancels`)
          : snapshot.loginCallbackEntry
            ? safe(`Browser callback · ${snapshot.loginCallbackEntry.masked || "Paste redirect URL or code…"} · Enter exchanges · Esc cancels`)
            : "Approval pending · Esc cancels";
      } else if (!editor.focused) editor.focus();
      editor.placeholder = panelMode === "model" ? "Search models or type provider/model…" : panelMode === "tree" ? "Optional fork name…" : "Ask Schway…";
      const workspace = controller.workspaceIdentity();
      let path = workspace?.root ?? options.workspaceRoot;
      if (path === options.home || path.startsWith(`${options.home}/`)) path = `~${path.slice(options.home.length)}`;
      header.content = new StyledText([bold(fg(theme.accent)("schway")), fg(theme.muted)(`  ${fitLine(safe(path), width - 8)}`)]);
      const status = snapshot.status === "running" ? "● Working · Esc stops" : snapshot.status === "error" ? "! Needs attention" : "Ready";
      const model = safe(`${snapshot.provider}/${snapshot.modelId}${snapshot.thinking ? ` · ${snapshot.thinking}` : ""}${snapshot.profile ? ` · ${snapshot.profile}` : ""}`);
      const statusWidth = Bun.stringWidth(status);
      footer.content = new StyledText([
        fg(theme.muted)(`${fitLine(model, Math.max(1, width - statusWidth - 3))}   `),
        fg(snapshot.status === "error" ? theme.error : snapshot.status === "running" ? theme.accent : theme.muted)(status),
      ]);
      const tail = snapshot.transcript.at(-1);
      const tailKey = `${tail?.id}:${tail?.text.length}:${tail?.toolStatus}`;
      if (lastTail && lastTail !== tailKey && !atBottom()) unseen = true;
      lastTail = tailKey;
      if (atBottom()) unseen = false;
      activity.content = fitLine(Date.now() < interactionNoticeUntil ? interactionNotice : unseen ? "↓ New activity · Ctrl+End to return to latest" : snapshot.branchTreeError ? safe(snapshot.branchTreeError) : snapshot.status === "running" ? "Working on your request…" : "", width);
      activity.fg = unseen ? theme.accent : snapshot.branchTreeError ? theme.error : theme.muted;
      activity.onMouseUp = () => { latest(); refresh(); };
      transcript.visible = !snapshot.branchTree;
      tree.visible = !!snapshot.branchTree;
      empty.visible = snapshot.transcript.length === 0;
      const ids = new Set(snapshot.transcript.map(entry => entry.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.root.destroyRecursively(); rows.delete(id); }
      for (const entry of snapshot.transcript) {
        let row = rows.get(entry.id);
        if (!row) {
          row = createTranscriptItem(renderer, entry, theme, syntax, () => {
            if (expandedTools.has(entry.id)) expandedTools.delete(entry.id); else expandedTools.add(entry.id);
            refresh();
          });
          rows.set(entry.id, row);
          transcript.add(row.root);
        }
        row.update({ ...entry, text: safe(entry.text), toolName: entry.toolName ? safe(entry.toolName) : undefined, toolSummary: entry.toolSummary ? safe(entry.toolSummary) : undefined }, allExpanded !== expandedTools.has(entry.id), snapshot.status === "running" && entry === tail, width - 1);
      }

      const available = completions();
      if (editor.plainText !== lastQuery) { completionIndex = 0; lastQuery = editor.plainText; }
      completionIndex = Math.min(completionIndex, Math.max(0, available.length - 1));
      picker.visible = !!snapshot.loginChooser || !!snapshot.loginApproval || !!snapshot.modelPicker || available.length > 0;
      const maxRows = Math.max(1, Math.min(6, Math.floor(renderer.height / 3) - 2));
      const pickerRows = snapshot.loginChooser ? Math.min(maxRows, snapshot.loginChooser.choices.length) + 1 : snapshot.loginApproval ? 2 : snapshot.modelPicker ? Math.min(maxRows, snapshot.modelPicker.entries.length) + 2 : Math.min(maxRows, available.length);
      const chromeRows = (header.visible ? 1 + (renderer.height >= 20 ? 1 : 0) : 0) + (activity.visible ? 1 : 0) + (hints.visible ? 1 : 0) + 3;
      // Reserve the transcript, composer borders, status and picker before
      // allowing the editor to grow. A wrapping placeholder also consumes rows.
      editor.maxHeight = Math.max(1, Math.min(6, Math.floor(renderer.height / 4), renderer.height - chromeRows - pickerRows - 1));
      const panelKey = JSON.stringify([snapshot.loginChooser, snapshot.loginApproval, snapshot.modelPicker, snapshot.branchTree, available, completionIndex, width, renderer.height]);
      if (panelKey !== panelFingerprint) {
        panelFingerprint = panelKey;
        clear(picker);
        if (snapshot.loginChooser) {
          textRow(picker, fitLine("Sign in · ↑/↓ select · Enter continue · Esc back", width - 2), theme.accent);
          const choices = snapshot.loginChooser.choices;
          const start = Math.max(0, Math.min(snapshot.loginChooser.selectedIndex - Math.floor(maxRows / 2), choices.length - maxRows));
          choices.slice(start, start + maxRows).forEach((choice, offset) => {
            const index = start + offset;
            textRow(picker, fitLine(`${index === snapshot.loginChooser!.selectedIndex ? "›" : " "} ${choice}`, width - 2), index === snapshot.loginChooser!.selectedIndex ? theme.accent : theme.text);
          });
        } else if (snapshot.loginApproval) {
          textRow(picker, "Complete ChatGPT approval · Esc cancels", theme.accent);
          textRow(picker, fitLine(safe(snapshot.loginApproval), width - 2), theme.text);
        } else if (snapshot.modelPicker) {
          const models = snapshot.modelPicker;
          textRow(picker, fitLine("Choose model · ↑/↓ select · Enter apply · Esc back", width - 2), theme.accent);
          const start = Math.max(0, Math.min(models.selectedIndex - Math.floor(maxRows / 2), models.entries.length - maxRows));
          models.entries.slice(start, start + maxRows).forEach((entry, offset) => {
            const index = start + offset;
            textRow(picker, fitLine(`${index === models.selectedIndex ? "›" : " "} ${entry.profile ? `profile:${entry.profile}` : `${entry.provider}/${entry.modelId}`}${entry.active ? " ✓ current" : ""}${entry.access ? ` · ${entry.access}` : entry.otherProvider ? " (other provider)" : ""}${entry.custom ? " (custom)" : ""}`, width - 2), index === models.selectedIndex ? theme.accent : theme.text);
          });
          const selected = models.entries[models.selectedIndex];
          textRow(picker, fitLine(models.error ?? (models.loading ? "Loading available models…" : selected ? `${selected.access ? `${selected.access} · ` : ""}${models.selectedIndex + 1}/${models.entries.length} · ${selected.contextWindow.toLocaleString()} context · ${selected.maxOutput.toLocaleString()} output${selected.supportedThinking ? ` · thinking: ${selected.supportedThinking.join("/") || "not advertised"}` : ""}` : "No matches. Try provider/model-id."), width - 2), models.error ? theme.error : theme.muted);
        } else if (available.length) {
          const start = Math.max(0, completionIndex - maxRows + 1);
          available.slice(start, start + maxRows).forEach(([name, description], offset) => {
            textRow(picker, fitLine(`${start + offset === completionIndex ? "›" : " "} /${name}  ${description}`, width - 2), start + offset === completionIndex ? theme.accent : theme.muted);
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
      hints.content = fitLine(panelMode ? "Enter confirm · Esc back" : available.length ? "↑/↓ select · Tab complete · Esc dismiss · Enter send" : renderer.width < 70 ? "Enter send · Ctrl+J newline · / help" : "Enter send · Ctrl+J newline · Ctrl+O tools · Alt+M model · / commands", width);
    } finally { refreshing = false; }
  }

  function submit() {
    const snapshot = controller.snapshot();
    if (snapshot.credentialEntry || snapshot.loginCallbackEntry) return;
    if (snapshot.loginChooser) {
      void controller.selectLoginChoice().then(refresh, fail);
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
    const themeCommand = /^\/theme(?:\s+(.*))?$/.exec(value.trim());
    if (themeCommand) {
      const requested = themeCommand[1]?.trim() || "auto";
      if (!["auto", "dark", "light"].includes(requested)) controller.fail("Usage: /theme [auto|dark|light]");
      else { mode = requested as ThemeMode; applyTheme(); }
      setDraft(""); refresh(); return;
    }
    if (value.trim() === "/session") {
      const workspace = controller.workspaceIdentity();
      controller.notice(`Session: ${snapshot.sessionId}\nConversation branch: ${snapshot.branchId}\nModel: ${snapshot.provider}/${snapshot.modelId}\nPrimary: ${workspace?.root ?? options.workspaceRoot}\nAttached: ${workspace?.extraRoots.join(", ") || "none"}`);
      setDraft(""); refresh(); return;
    }
    void options.submit(value, () => {
      // Credential callback commands must never enter prompt recall.
      if (!value.trimStart().startsWith("/") && history.at(-1) !== value) {
        history.push(value); if (history.length > 100) history.shift();
      }
      historyIndex = -1;
      setDraft("");
      dismissedQuery = undefined;
      latest();
    }).then(refresh, fail);
    refresh();
  }

  function fail(error: unknown) {
    controller.fail(error instanceof Error ? error.message : String(error));
    refresh();
  }

  function onKey(key: KeyEvent) {
    if (key.defaultPrevented || key.eventType === "release" || controller.snapshot().credentialEntry || controller.snapshot().loginCallbackEntry) return;
    const name = key.name.toLowerCase();
    const snapshot = controller.snapshot();
    const handled = () => { key.preventDefault(); key.stopPropagation(); refresh(); };
    if (key.ctrl && name === "c" && copySelection()) {
      renderer.clearSelection();
      handled(); return;
    }
    if (key.ctrl && name === "l") {
      // Re-enter the terminal through the renderer's lifecycle so stale physical
      // cells are repainted even when its cached scene has not changed.
      renderer.suspend();
      renderer.resume();
      handled(); return;
    }
    if ((key.meta || key.option) && name === "m") { controller.openModelPicker(); handled(); return; }
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
      else if (completions().length) dismissedQuery = editor.plainText;
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
      if (choices.length) { completionIndex = (completionIndex + delta + choices.length) % choices.length; handled(); return; }
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
      if (selected) { setDraft(`/${selected[0]} `); handled(); }
    }
  }

  editor.onSubmit = submit;
  editor.onContentChange = () => {
    if (refreshing || destroyed) return;
    if (controller.snapshot().modelPicker) controller.searchModels(editor.plainText);
    refresh();
  };
  renderer.keyInput.on("keypress", onKey);
  renderer.on("selection", onSelection);
  const unbindCredential = bindCredentialInput(renderer.keyInput, controller, refresh);
  const onTheme = () => { if (mode === "auto") applyTheme(); };
  renderer.on("theme_mode", onTheme);
  renderer.on("resize", refresh);
  renderer.setBackgroundColor(theme.background);
  editor.focus();
  refresh();
  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unbindCredential();
      renderer.keyInput.off("keypress", onKey);
      renderer.off("selection", onSelection);
      renderer.off("theme_mode", onTheme);
      renderer.off("resize", refresh);
      root.destroyRecursively();
      syntax.destroy();
    },
  };
}
