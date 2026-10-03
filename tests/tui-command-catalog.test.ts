import { expect, test } from "bun:test";
import { commandCatalog, paletteChoices, type CommandChoice, type KeyboardGuideAvailability, type KeyboardGuideId } from "../src/tui/command-catalog.ts";
import type { SkillDiscovery } from "../src/skills/skills.ts";

const available = Object.freeze({ available: true } as const);
const observations: Readonly<Record<KeyboardGuideId, KeyboardGuideAvailability>> = Object.freeze({
  newline: available, "inspect-copy": available, "copy-selection": available, "approval-mode": available,
  shortcuts: available, details: available, review: available, cancel: available,
});

function command(name: string, description = "", extra: Partial<CommandChoice> = {}): CommandChoice {
  return { id: `command:${name}`, name, insertion: `/${name} `, description, source: "fixture", available: true, ...extra };
}

test("the audit searches and curated intents find concrete keyboard guidance", () => {
  for (const [query, id] of [
    ["newline", "newline"], ["line break", "newline"], ["copy", "inspect-copy"], ["copy code", "inspect-copy"],
    ["approval", "approval-mode"], ["mode", "approval-mode"], ["shortcuts", "shortcuts"],
    ["details", "details"], ["diagnostics", "details"], ["review", "review"], ["stop", "cancel"],
  ]) {
    const row = paletteChoices(commandCatalog([]), observations, query).find(row => row.id === `keyboard:${id}`);
    expect(row?.kind).toBe("keyboard");
    if (row?.kind !== "keyboard") throw new Error(`Missing guidance for ${query}`);
    expect(row.label.length).toBeGreaterThan(0);
    expect(row.description.length).toBeGreaterThan(0);
    expect(row.guidance.length).toBeGreaterThan(0);
    expect(row.shortcut.length).toBeGreaterThan(0);
    expect("insertion" in row).toBe(false);
    expect(Object.values(row).some(value => typeof value === "function")).toBe(false);
  }
});

test("key aliases describe only the current routes and retain semantic identities", () => {
  for (const [query, id, shortcut] of [
    [" CTRL+J ", "newline", "Shift+Enter or Ctrl+J"], ["shift+enter", "newline", "Shift+Enter or Ctrl+J"],
    ["alt+i", "inspect-copy", "Alt+I, then C"], ["ctrl+c", "copy-selection", "Ctrl+C"],
    ["shift+tab", "approval-mode", "Shift+Tab"], ["alt+h", "shortcuts", "Alt+H"],
    ["ctrl+i", "details", "Ctrl+I"], ["alt+r", "review", "Alt+R"], ["escape", "cancel", "Esc; Ctrl+C without selected text"],
  ]) {
    const row = paletteChoices([], observations, query)[0];
    expect(row).toMatchObject({ kind: "keyboard", id: `keyboard:${id}`, shortcut });
  }
  expect(paletteChoices([], observations, "F2")).toEqual([]);
});

test("unavailable keyboard actions remain readable with the exact observed reason", () => {
  const blocked = { ...observations,
    "inspect-copy": { available: false, reason: "No code or tool result · Enter send a task" } as const,
    "approval-mode": { available: false, reason: "Close conversation search · Esc restore" } as const,
    review: { available: false, reason: "Turn running · Esc stop" } as const,
  };
  for (const [query, id] of [["copy", "inspect-copy"], ["approval", "approval-mode"], ["review", "review"]] as const) {
    const before = paletteChoices([], observations, query).find(row => row.id === `keyboard:${id}`)!;
    const after = paletteChoices([], blocked, query).find(row => row.id === before.id)!;
    expect(after).toMatchObject({ kind: "keyboard", ...blocked[id] });
    expect(after.kind === "keyboard" && after.guidance).toBe(before.kind === "keyboard" && before.guidance);
    expect("insertion" in after).toBe(false);
  }
});

test("enriched availability observations cannot replace guidance or add insertion and execution capabilities", () => {
  let calls = 0;
  const extra = {
    label: "Replacement label", shortcut: "Replacement key", description: "Replacement description",
    guidance: "Replacement guidance", aliases: ["replacement alias"], insertion: "/delete-session fixture",
    execute: () => { calls++; }, reason: "Unexpected reason for an available action",
  };
  const allowed = { ...extra, available: true as const };
  const blocked = { ...extra, available: false as const, reason: "Turn running · Esc stop" };
  const enriched: Readonly<Record<KeyboardGuideId, KeyboardGuideAvailability>> = {
    ...observations, newline: allowed, review: blocked,
  };
  const original = paletteChoices([], observations);
  const rows = paletteChoices([], enriched);
  const newline = rows.find(row => row.id === "keyboard:newline")!;
  expect(newline).toEqual(original.find(row => row.id === newline.id)!);
  expect("reason" in newline).toBe(false);
  const originalReview = original.find(row => row.id === "keyboard:review");
  if (originalReview?.kind !== "keyboard") throw new Error("Expected review guidance");
  expect(rows.find(row => row.id === "keyboard:review")).toEqual({
    ...originalReview, available: false, reason: blocked.reason,
  });
  for (const row of rows) {
    expect("insertion" in row).toBe(false);
    expect(Object.values(row).some(value => typeof value === "function")).toBe(false);
  }
  expect(calls).toBe(0);
});

test("empty discovery inserts a keyboard section before deletion while preserving every command byte and order", () => {
  const commands = Object.freeze(commandCatalog([]).map(entry => Object.freeze(entry)));
  const before = structuredClone([...commands]);
  const rows = paletteChoices(commands, observations, "  ");
  expect(rows.filter(row => row.kind === "command").map(({ kind, ...row }) => row)).toEqual([...commands]);
  expect(rows.filter(row => row.kind === "keyboard")).toHaveLength(8);
  expect(rows.findIndex(row => row.kind === "keyboard")).toBe(commands.length - 1);
  expect(rows.at(-1)).toMatchObject({ kind: "command", id: "builtin:delete-session", group: "destructive", destructive: true });
  expect(commands).toEqual(before);
  expect(commandCatalog([])).toEqual(before);
});

test("exact matches outrank prefixes, then word starts, substrings and subsequences with stable ties", () => {
  const commands = [command("d-x-r-x-a-x-f-x-t"), command("otherdraft"), command("save-draft"), command("drafting"),
    command("description-only", "draft"), command("draft"), command("unavailable", "draft", { available: false })];
  const names = () => paletteChoices(commands, observations, "draft").filter(row => row.kind === "command").map(row => row.name);
  expect(names()).toEqual(["draft", "description-only", "unavailable", "drafting", "save-draft", "otherdraft", "d-x-r-x-a-x-f-x-t"]);
  expect(names()).toEqual(names());
});

test("normalized Unicode search preserves Thai, decomposed accents and resolved argument insertions", () => {
  const commands = [command("thinking low", "low", { id: "thinking:low", insertion: "/thinking low", source: "argument" }),
    command("thai", "ขึ้นบรรทัดใหม่ ภาษาไทย", { insertion: "/thai สวัสดี 🧪\ne\u0301" }),
    command("cafe\u0301", "Résumé")];
  for (const query of ["thinking low", "/thinking low"]) {
    expect(paletteChoices(commands, observations, query)[0]).toEqual({ kind: "command", ...commands[0]! });
  }
  expect(paletteChoices(commands, observations, "ภาษาไทย")[0]).toEqual({ kind: "command", ...commands[1]! });
  expect(paletteChoices(commands, observations, " CAFÉ ")[0]).toEqual({ kind: "command", ...commands[2]! });
  expect(paletteChoices(commands, observations, "Re\u0301sume\u0301")[0]?.id).toBe(commands[2]!.id);
  expect(paletteChoices(commands, observations, "\u{10ffff}")).toEqual([]);
});

test("keyboard aliases never acquire slash ownership or hide real collisions and diagnostics", () => {
  const skills: SkillDiscovery = {
    skills: [{ name: "newline", description: "Custom line helper", scope: "project", userOnly: false,
      dir: "/skills/newline", skillFile: "/skills/newline/SKILL.md", displayPath: "newline" }],
    collisions: [{ name: "theme", command: "theme", source: "/skills/theme/SKILL.md" }],
    ambiguous: [{ name: "duplicate", sources: ["one", "two"] }],
    diagnostics: [{ source: "broken-extension", reason: "Unavailable extension · Repair its configuration" }],
  };
  const extensions = [
    { name: "copy", description: "Custom copy", source: "/modules/copy.ts", packageName: "copy-pkg" },
    { name: "duplicate", description: "Custom duplicate", source: "/modules/duplicate.ts", packageName: "duplicate-pkg" },
  ];
  const commands = commandCatalog(extensions, skills);
  const before = structuredClone(commands);
  for (const name of ["copy", "newline"]) {
    const rows = paletteChoices(commands, observations, name);
    expect(rows.some(row => row.kind === "keyboard")).toBe(true);
    expect(rows.find(row => row.kind === "command" && row.name === name)).toMatchObject({ available: true, insertion: `/${name} ` });
  }
  for (const query of ["theme", "duplicate", "broken-extension", "delete-session", "copy-pkg"]) {
    const rows = paletteChoices(commands, observations, query);
    const matching = before.filter(row => row.name === query || row.source === query || row.provenance === query);
    expect(matching.length).toBeGreaterThan(0);
    for (const row of matching) expect(rows.find(result => result.id === row.id)).toEqual({ kind: "command", ...row });
  }
  expect(paletteChoices(commands, observations).filter(row => row.kind === "command").map(({ kind, ...row }) => row)).toEqual(before);
  expect(commandCatalog(extensions, skills)).toEqual(before);
  expect(commands.every(row => !row.id.startsWith("keyboard:"))).toBe(true);
});

test("filtering and observation changes preserve IDs without sharing mutable guide metadata", () => {
  const initial = paletteChoices([], observations);
  const blocked = { ...observations, newline: { available: false, reason: "Close the panel · Esc back" } as const };
  const filtered = paletteChoices([], blocked, "line break");
  expect(filtered[0]?.id).toBe(initial[0]?.id);
  expect(new Set(initial.map(row => row.id)).size).toBe(initial.length);
  const row = initial[0]!;
  if (row.kind !== "keyboard") throw new Error("Expected guidance");
  (row.aliases as string[]).push("polluted alias");
  expect(paletteChoices([], observations, "polluted alias")).toEqual([]);
  expect(Object.keys(observations)).toHaveLength(8);
});
