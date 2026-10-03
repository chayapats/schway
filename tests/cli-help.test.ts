import { expect, test } from "bun:test";
import { CLI_AUTH_MODES, CLI_OPENAI_AUTH_MODES, CLI_PROVIDERS, CLI_THINKING_LEVELS, CLI_XAI_AUTH_MODES, parseArgs, type CliArgs } from "../src/cli/args.ts";
import { CLI_OPTIONS, formatDoctorHelp, formatHelp } from "../src/cli/help.ts";
import { parseSessionsArguments } from "../src/cli/sessions.ts";

test("main help groups options and examples in the documented order", () => {
  const lines = formatHelp().trimEnd().split("\n");
  expect(lines[0]).toBe("schway — a lean, fast coding agent for your terminal");
  expect(lines[1]).toBe("");
  expect(lines.slice(2).filter((line) => line && !line.startsWith(" "))).toEqual([
    "Usage", "Common", "Model and auth", "Sessions", "Workspace",
    "Output and diagnostics", "Advanced", "Examples",
  ]);
  expect(lines.slice(3, 6).map((line) => line.trim().split(/ {2,}/))).toEqual([
    ["schway", "Start an interactive session"],
    ['schway -p "<task>" [--approval <auto|ask|read-only>]', "Run one task"],
    ["schway doctor", "Check your setup"],
  ]);
});

const EXPECTED_OPTIONS = {
  "-p": { prompt: "explain this project" },
  "--approval": { approval: "read-only" },
  "-h": { help: true },
  "-V": { version: true },
  "--provider": { provider: "openai" },
  "--model": { model: "example-model" },
  "--profile": { profile: "local" },
  "--thinking": { thinking: "low" },
  "--openai-auth": { openaiAuth: "auto" },
  "--xai-auth": { xaiAuth: "auto" },
  "--api-key": { apiKey: "example-key" },
  "--resume": { resume: "example-session" },
  "--branch": { branch: "example-branch", resume: "example-session" },
  "--add-dir": { addDirs: ["../shared"] },
  "--json": { json: true },
  "--debug": { debug: true },
  "--debug-file": { debugFile: "debug.jsonl", debug: true },
  "--base-url": { baseUrl: "http://localhost:11434/v1" },
  "--header": { headers: { "X-Example": "value" } },
  "--body": { extraBody: { example: true } },
  "--auth": { auth: "none" },
  "--max-turns": { maxTurns: 2 },
  "--max-output": { maxOutput: 1024 },
  "--context-window": { contextWindow: 8192 },
  "--max-concurrent-tools": { maxConcurrentTools: 4 },
  "--env-file": { envFiles: [".env.local"] },
  "--extension": { extensions: ["./extension.ts"] },
} satisfies Record<string, Partial<CliArgs>>;

test("each documented option and alias sets its CLI field in both accepted forms", () => {
  expect(CLI_OPTIONS.map((option) => option.flags[0])).toEqual(Object.keys(EXPECTED_OPTIONS));
  for (const option of CLI_OPTIONS) {
    expect(Boolean(option.sample)).toBe(Boolean(option.value));
    const expected = EXPECTED_OPTIONS[option.flags[0] as keyof typeof EXPECTED_OPTIONS];
    for (const flag of option.flags) {
      const forms = option.sample === undefined ? [[flag]] : [[flag, option.sample], [`${flag}=${option.sample}`]];
      for (const argv of forms) {
        if (flag === "--branch") argv.push("--resume", "example-session");
        expect(parseArgs(argv), argv.join(" ")).toEqual({ args: { json: false, help: false, ...expected } });
      }
    }
  }
});

test("the option registry and parser flag literals cover each other", async () => {
  const source = (await Promise.all(["args.ts", "version.ts"].map(file => Bun.file(new URL(`../src/cli/${file}`, import.meta.url)).text()))).join("\n");
  const parsedFlags = new Set([...source.matchAll(/(["'])(-{1,2}[A-Za-z][A-Za-z-]*)(?:=)?\1/g)].map((match) => match[2]));
  const helpFlags = CLI_OPTIONS.flatMap((option) => [...option.flags]);
  expect(new Set(helpFlags).size).toBe(helpFlags.length);
  expect([...parsedFlags].sort()).toEqual([...helpFlags].sort());
});

test("main help shows each option once at a shared description column", () => {
  const text = formatHelp();
  const rows = text.split("\n").filter((line) => line.startsWith("  -"));
  expect(rows).toHaveLength(CLI_OPTIONS.length);
  for (const option of CLI_OPTIONS) {
    const label = option.flags.join(", ") + (option.value ? ` ${option.value}` : "");
    const matches = rows.filter((row) => row.startsWith(`  ${label} `));
    expect(matches, label).toHaveLength(1);
    expect(matches[0]!.indexOf(option.description)).toBe(29);
  }
  for (const flag of ["--header", "--add-dir", "--env-file", "--extension"]) {
    expect(rows.find((row) => row.startsWith(`  ${flag} `))).toContain("(repeatable)");
  }
  expect(rows.find((row) => row.startsWith("  --branch "))).toContain("needs --resume");
});

test("doctor help contains exactly the diagnostic option subset", () => {
  const text = formatDoctorHelp();
  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toBe("schway doctor — check your setup without running a model");
  expect(lines.slice(1, 4)).toEqual(["", "Usage", "  schway doctor [options]"]);
  expect(lines.slice(2).filter((line) => line && !line.startsWith(" "))).toEqual([
    "Usage", "Common", "Model and auth", "Workspace", "Output and diagnostics", "Advanced", "Examples",
  ]);
  const rows = lines.filter((line) => line.startsWith("  -"));
  const labels = rows.map((line) => line.slice(2, 29).trimEnd());
  expect(labels).toEqual(CLI_OPTIONS.filter((option) => option.doctor).map((option) => option.flags.join(", ") + (option.value ? ` ${option.value}` : "")));
  expect(CLI_OPTIONS.filter((option) => option.doctor).map((option) => option.flags[0])).toEqual([
    "-h", "--provider", "--profile", "--thinking", "--openai-auth", "--xai-auth", "--api-key", "--add-dir", "--json",
    "--base-url", "--header", "--body", "--auth", "--max-turns", "--max-output", "--context-window", "--max-concurrent-tools", "--env-file", "--extension",
  ]);
  expect(rows.find((row) => row.startsWith("  --json "))).toContain("Print diagnostics as a JSON object");
  expect(text).toContain("schway --version");
  expect(text).toContain("Show the installed version");
});

test("help is plain text, terminal-independent and never wider than 80 columns", () => {
  for (const format of [formatHelp, formatDoctorHelp]) {
    const text = format();
    expect(text).not.toMatch(/\x1b|anthropic|claude/i);
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
    const headings = text.split("\n");
    for (let index = 2; index < headings.length; index++) {
      if (headings[index] && !headings[index]!.startsWith(" ")) expect(headings[index - 1]).toBe("");
    }
  }
});

test("every example is a complete parseable command with placeholder model and session IDs", () => {
  for (const format of [formatHelp, formatDoctorHelp]) {
    const examples = format().split("\nExamples\n")[1]!.trim().split("\n").map((line) => line.trim());
    expect(examples.length).toBeGreaterThanOrEqual(format === formatHelp ? 4 : 2);
    expect(examples).toContain("schway doctor --json");
    if (format === formatHelp) {
      expect(examples).toContain("schway --resume <id>");
      expect(examples.some((line) => line.includes(" -p ") && line.includes("--json"))).toBe(true);
      expect(examples.some((line) => line.includes("--provider") && line.includes("--model <id>"))).toBe(true);
    } else expect(examples).toContain("schway doctor");
    for (const example of examples) {
      const words = example.match(/"[^"]*"|\S+/g)!.map((word) => word.replace(/^"|"$/g, ""));
      expect(words.shift()).toBe("schway");
      if (words[0] === "sessions") {
        expect(() => parseSessionsArguments(words.slice(1))).not.toThrow();
        continue;
      }
      if (words[0] === "doctor") words.shift();
      const parsed = parseArgs(words);
      expect(parsed).not.toHaveProperty("error");
      if ("args" in parsed) {
        if (parsed.args.model) expect(parsed.args.model).toBe("<id>");
        if (parsed.args.resume) expect(parsed.args.resume).toBe("<id>");
      }
    }
  }
});

test("help value lists use every accepted parser value without changing normalization", () => {
  for (const [flag, values, field] of [
    ["--provider", CLI_PROVIDERS, "provider"],
    ["--thinking", CLI_THINKING_LEVELS, "thinking"],
    ["--openai-auth", CLI_OPENAI_AUTH_MODES, "openaiAuth"],
    ["--xai-auth", CLI_XAI_AUTH_MODES, "xaiAuth"],
    ["--auth", CLI_AUTH_MODES, "auth"],
  ] as const) {
    const row = formatHelp().split("\n").find((line) => line.startsWith(`  ${flag} `))!;
    for (const value of values) {
      expect(row).toContain(value);
      expect(parseArgs([flag, value])).toEqual({ args: { json: false, help: false, [field]: value } });
    }
    expect(parseArgs([flag, "unsupported"])).toHaveProperty("error");
  }
  expect(parseArgs(["--thinking", " LOW "])).toHaveProperty("args.thinking", "low");
  expect(parseArgs(["--openai-auth", " AUTO "])).toHaveProperty("args.openaiAuth", "auto");
  for (const flag of ["--provider", "--auth", "--xai-auth"]) expect(parseArgs([flag, " AUTO "])).toHaveProperty("error");
});
