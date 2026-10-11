import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import { fitCredentialEntry, fitEntryValue, type CredentialEntryPanel } from "../src/tui/credential-entry.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

/** Build a real renderer, view and controller at one terminal size, with no network and an in-memory credential store. */
async function entryView(width: number, height: number) {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { createConversationView } = await import("../src/tui/view.ts");
  const { dispatchEditorInput } = await import("../src/tui/commands.ts");
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const wait = async ({ signal }: { signal: AbortSignal }) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false as const, message: "Cancelled" }; };
  const controller = new TuiController({ session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "entry-fit",
    model: createScriptedModel(), contextManager: createContextManager(workspace), secrets: [],
    configEditor: new ConfigEditor({}, { user: "/home/test/.schway/config.json", project: "/project/.schway/config.json" }),
    stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: wait, grokLogin: wait },
  });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], quit: () => {}, openUrl: async () => {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted) });
  const settle = async () => { await Bun.sleep(2); view.refresh(); await terminal.flush(); };
  await settle();
  const dispose = () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); };
  return { ...terminal, controller, view, settle, dispose };
}

type EntryView = Awaited<ReturnType<typeof entryView>>;

/** Open the endpoint URL entry the way a user does, paste `url` and, when asked, press Enter to show its validation error. */
async function pasteEndpoint(ui: EntryView, url: string, submit: boolean): Promise<void> {
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle();
  while (ui.controller.snapshot().loginChooser!.selectedId !== "compatible") ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter(); await ui.settle();
  await ui.mockInput.pasteBracketedText(url); await ui.settle();
  if (submit) { ui.mockInput.pressEnter(); await ui.settle(); }
}

const HINT = "Enter continue · Esc cancel";
const SIZES = [[24, 8], [32, 12], [40, 10]] as const;
// A short URL, the 75-character URL and the 420-character URL from the report; none has a scheme, so Enter shows an error.
const URLS = ["localhost:8787", `localhost:8787/${"a".repeat(59)}z`, `localhost:8787/${"a".repeat(404)}z`];

/** Open the OpenAI API-key entry (Alt+L, then OpenAI) or the ChatGPT callback entry (Alt+L, Tab, then the callback row) and paste `secret`. */
async function pasteMasked(ui: EntryView, surface: "openai" | "callback", secret: string): Promise<void> {
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle();
  if (surface === "callback") { ui.mockInput.pressTab(); await ui.settle(); }
  const id = surface === "callback" ? "chatgpt-callback" : "openai";
  while (ui.controller.snapshot().loginChooser!.selectedId !== id) ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter(); await ui.settle();
  await ui.mockInput.pasteBracketedText(secret); await ui.settle();
}

/** True for a row that shows the end of the endpoint URLs these tests paste. */
const urlEnd = (row: string) => /[az]$|8787$/.test(row.trimEnd()) && !row.includes("Enter a full");

/** Assert the hint rows sit whole between the last value row and the composer cap, and the status bar names only Esc. */
function expectEntryFits(ui: EntryView, height: number, label: string, hint = HINT, valueRow = urlEnd): string[] {
  const frame = ui.captureCharFrame(), rows = frame.split("\n").slice(0, height), cursor = ui.renderer.getCursorState();
  const context = `${label}\n${frame}`;
  expect(rows[height - 1]!.trim(), context).toEndWith("Esc cancel");
  expect(rows[height - 1], context).not.toContain("Enter");
  expect(rows[height - 2]!.trim(), context).toMatch(/^▀+$/);
  // Walk up from the cap until the trimmed rows spell the whole hint; a wrapped hint breaks only at ` · `.
  let start = height - 2, text = "";
  while (text !== hint && start > 0) {
    const row = rows[--start]!.trim();
    expect(row, context).not.toEndWith("·");
    text = text ? `${row} · ${text}` : row;
  }
  expect(text, context).toBe(hint);
  // The caret sits right after the value's last cell on the last value row, above any error and the hint.
  expect(cursor.visible, context).toBe(true);
  const caretRow = rows[cursor.y - 1]!;
  expect(valueRow(caretRow), context).toBe(true);
  expect(cursor.x, context).toBe(Bun.stringWidth(caretRow.trimEnd()) + 1);
  expect(cursor.y - 1, context).toBeLessThan(start);
  expect(rows.slice(cursor.y, start).some(valueRow), context).toBe(false);
  return rows;
}

test("at 24x8, 32x12 and 40x10 the endpoint entry keeps its hint, value and caret above the status bar, with or without an error", async () => {
  for (const [width, height] of SIZES) for (const url of URLS) for (const submit of [false, true]) {
    const ui = await entryView(width, height);
    try {
      await pasteEndpoint(ui, url, submit);
      const label = `${width}x${height} ${url.length} chars${submit ? " with error" : ""}`;
      expect(!!ui.controller.snapshot().endpointUrlEntry?.error, label).toBe(submit);
      const rows = expectEntryFits(ui, height, label);
      // The error keeps at least its first sentence on screen.
      if (submit) expect(rows.some(row => row.includes("Enter a full URL")), `${label}\n${rows.join("\n")}`).toBe(true);
    } finally { ui.dispose(); }
  }
});

test("at 24x8, 32x12 and 40x10 the masked API-key and callback entries keep their hint, last mask row and caret above the status bar", async () => {
  const hints = { openai: "Enter save · Esc cancel", callback: "Enter sign in · Esc cancel" } as const;
  // Long enough that each mask reaches its 64-bullet cap, which takes four rows at 24 columns.
  const secrets = { openai: `sk-${"k".repeat(120)}`, callback: `http://localhost:1455/auth/callback?code=${"x".repeat(120)}` } as const;
  for (const surface of ["openai", "callback"] as const) for (const [width, height] of SIZES) {
    const ui = await entryView(width, height);
    try {
      await pasteMasked(ui, surface, secrets[surface]);
      const snapshot = ui.controller.snapshot(), masked = surface === "openai" ? snapshot.credentialEntry?.masked : snapshot.loginCallbackEntry?.masked;
      expect(masked).toBe("•".repeat(64));
      const rows = expectEntryFits(ui, height, `${surface} ${width}x${height}`, hints[surface], row => row.trimEnd().endsWith("•"));
      // The mask shows whole or keeps its end behind `…` within the value row bound, and never shows the secret.
      const maskRows = rows.filter(row => row.includes("•")), shown = maskRows.map(row => row.trim()).join("");
      expect(maskRows.length).toBeLessThanOrEqual(Math.max(1, Math.min(6, Math.floor(height / 4))));
      expect(shown === masked || /^…•+$/.test(shown), shown).toBe(true);
      if (width === 24) expect(shown).toStartWith("…");
      expect(rows.join("\n")).not.toMatch(/kkkk|xxxx|localhost:1455/);
    } finally { ui.dispose(); }
  }
});

test("a wide-grapheme endpoint URL stays within the value row bound and keeps its end at the caret", async () => {
  for (const [width, height] of [...SIZES, [40, 16], [41, 16], [50, 24]] as const) {
    const ui = await entryView(width, height);
    try {
      await pasteEndpoint(ui, `http://example.test/${"漢".repeat(300)}z`, false);
      const frame = ui.captureCharFrame(), rows = frame.split("\n"), cursor = ui.renderer.getCursorState();
      const valueRows = rows.filter(row => row.includes("漢"));
      expect(valueRows.length, frame).toBeLessThanOrEqual(Math.max(1, Math.min(6, Math.floor(height / 4))));
      expect(valueRows[0]!.trim(), frame).toStartWith("…");
      expect(rows[cursor.y - 1], frame).toBe(valueRows.at(-1)!);
      expect(valueRows.at(-1)!.trimEnd(), frame).toEndWith("漢z");
      if (height < 14) expectEntryFits(ui, height, `${width}x${height} wide`);
    } finally { ui.dispose(); }
  }
});

test("fitEntryValue keeps a wide-grapheme value within its rows when a wide grapheme skips a row's last cell", () => {
  /** Rows a character-wrapping renderer uses for `text` at `columns`, moving a grapheme that does not fit to the next row. */
  const rowsOf = (text: string, columns: number) => {
    let rows = 1, column = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      const cells = Bun.stringWidth(segment);
      if (column + cells > columns && column > 0) { rows++; column = 0; }
      column += cells;
    }
    return rows;
  };
  for (const columns of [17, 21, 33, 34]) for (const rows of [1, 2, 3, 4, 6]) {
    const fitted = fitEntryValue(`a${"漢".repeat(400)}z`, columns, rows);
    expect(rowsOf(fitted, columns), `${columns}x${rows}: ${fitted}`).toBeLessThanOrEqual(rows);
    expect(fitted).toStartWith("…");
    expect(fitted).toEndWith("漢z");
    // Nothing more fits: one more grapheme from the value would add a row.
    expect(rowsOf(`…漢${fitted.slice(1)}`, columns)).toBeGreaterThan(rows);
  }
  expect(fitEntryValue("漢".repeat(8), 16, 1)).toBe("漢".repeat(8));
  expect(fitEntryValue("漢".repeat(9), 17, 2)).toBe("漢".repeat(9));
});

test("a short entry gives up extra value rows, then error rows, then the title, and keeps its hint whole", () => {
  const rowsOf = (text: string, columns: number) => Math.ceil(Bun.stringWidth(text) / columns);
  const panel: CredentialEntryPanel = { kind: "endpoint", title: "Endpoint URL", value: `localhost:8787/${"a".repeat(100)}`, placeholder: "Paste or type a URL…",
    error: "Enter a full URL · Use http:// or https://", hint: HINT };
  const fit = (columns: number, rows: number, maxValueRows: number, entry = panel) => {
    const { value, ...rest } = fitCredentialEntry(entry, columns, rows, maxValueRows);
    return { ...rest, valueRows: rowsOf(value, columns - 1) };
  };
  // Room for everything: the error wraps whole and the value keeps its bound.
  expect(fit(34, 9, 3)).toEqual({ title: "Endpoint URL", valueRows: 3, error: panel.error!, hint: HINT });
  // Extra value rows go first.
  expect(fit(34, 5, 3)).toEqual({ title: "Endpoint URL", valueRows: 1, error: panel.error!, hint: HINT });
  // Then the error keeps its first sentence on one row.
  expect(fit(34, 4, 3)).toEqual({ title: "Endpoint URL", valueRows: 1, error: "Enter a full URL", hint: HINT });
  // Then the title goes; a hint wider than a row breaks at ` · `.
  expect(fit(18, 4, 2)).toEqual({ title: "", valueRows: 1, error: "Enter a full URL", hint: "Enter continue\nEsc cancel" });
  expect(fit(18, 3, 2)).toEqual({ title: "", valueRows: 1, error: "", hint: "Enter continue\nEsc cancel" });
  // A value that needs fewer rows than the bound takes only its own rows, and a short value is never shortened.
  expect(fitCredentialEntry({ ...panel, error: undefined, value: "localhost:8787" }, 34, 9, 3)).toEqual({ title: "Endpoint URL", value: "localhost:8787", error: "", hint: HINT });
  // A long title shortens to one row before it goes; spare rows stay with the title, not an empty value.
  const key: CredentialEntryPanel = { kind: "credential", title: "API key · Compatible endpoint (h:1)", value: "", placeholder: "Paste key…", hint: "Enter save · Esc back" };
  expect(fitCredentialEntry(key, 18, 6, 2)).toEqual({ title: key.title, value: "Paste key…", error: "", hint: "Enter save\nEsc back" });
  expect(fitCredentialEntry(key, 18, 5, 2)).toEqual({ title: "API key · Compati…", value: "Paste key…", error: "", hint: "Enter save\nEsc back" });
  expect(fitCredentialEntry(key, 18, 3, 2)).toEqual({ title: "", value: "Paste key…", error: "", hint: "Enter save\nEsc back" });
  // A placeholder that would wrap past its rows shortens to one.
  const callback: CredentialEntryPanel = { kind: "callback", title: "Browser callback", value: "", placeholder: "Paste redirect URL or code…", hint: "Enter sign in · Esc cancel" };
  expect(fitCredentialEntry(callback, 18, 4, 2).value).toBe("Paste redirect U…");
  expect(fitCredentialEntry(callback, 18, 5, 2).value).toBe(callback.placeholder);
});
