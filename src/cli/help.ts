import {
  CLI_AUTH_MODES,
  CLI_OPENAI_AUTH_MODES,
  CLI_PROVIDERS,
  CLI_THINKING_LEVELS,
  CLI_XAI_AUTH_MODES,
} from "./args.ts";

const SECTIONS = [
  "Common", "Model and auth", "Sessions", "Workspace",
  "Output and diagnostics", "Advanced",
] as const;

type Option = {
  flags: readonly string[];
  value?: string;
  section: (typeof SECTIONS)[number];
  description: string;
  doctor: boolean;
  doctorDescription?: string;
  sample?: string;
};

/** Describe every accepted CLI option once for main and diagnostic help. */
export const CLI_OPTIONS: readonly Option[] = [
  { flags: ["-p"], value: "<task>", section: "Common", description: "Run one task without the interactive UI", doctor: false, sample: "explain this project" },
  { flags: ["--approval"], value: "<mode>", section: "Common", description: "Use auto or read-only for tools", doctor: false, sample: "read-only" },
  { flags: ["-h", "--help"], section: "Common", description: "Show this help", doctor: true },
  { flags: ["--provider"], value: "<name>", section: "Model and auth", description: `Use ${CLI_PROVIDERS.join(", ")}`, doctor: true, sample: "openai" },
  { flags: ["--model"], value: "<id>", section: "Model and auth", description: "Choose a model", doctor: false, sample: "example-model" },
  { flags: ["--profile"], value: "<name>", section: "Model and auth", description: "Use a named compatible endpoint profile", doctor: true, sample: "local" },
  { flags: ["--thinking"], value: "<level>", section: "Model and auth", description: `Use ${CLI_THINKING_LEVELS.join(",")}`, doctor: true, sample: "low" },
  { flags: ["--openai-auth"], value: "<mode>", section: "Model and auth", description: `Use ${CLI_OPENAI_AUTH_MODES.join(", ")}`, doctor: true, sample: "auto" },
  { flags: ["--xai-auth"], value: "<mode>", section: "Model and auth", description: `Use ${CLI_XAI_AUTH_MODES.join(", ")}`, doctor: true, sample: "auto" },
  { flags: ["--api-key"], value: "<key>", section: "Model and auth", description: "Use an API key for this run only", doctor: true, sample: "example-key" },
  { flags: ["--resume"], value: "<session-id>", section: "Sessions", description: "Continue a saved session", doctor: false, sample: "example-session" },
  { flags: ["--branch"], value: "<branch-id>", section: "Sessions", description: "Continue a branch (needs --resume)", doctor: false, sample: "example-branch" },
  { flags: ["--add-dir"], value: "<directory>", section: "Workspace", description: "Attach another project as context (repeatable)", doctor: true, sample: "../shared" },
  { flags: ["--json"], section: "Output and diagnostics", description: "Stream runtime events as JSON lines", doctor: true, doctorDescription: "Print diagnostics as a JSON object" },
  { flags: ["--debug"], section: "Output and diagnostics", description: "Write a local debug log", doctor: false },
  { flags: ["--debug-file"], value: "<path>", section: "Output and diagnostics", description: "Write the debug log to this file", doctor: false, sample: "debug.jsonl" },
  { flags: ["--base-url"], value: "<url>", section: "Advanced", description: "Use a compatible endpoint URL", doctor: true, sample: "http://localhost:11434/v1" },
  { flags: ["--header"], value: "<name:value>", section: "Advanced", description: "Add a request header (repeatable)", doctor: true, sample: "X-Example:value" },
  { flags: ["--body"], value: "<json>", section: "Advanced", description: "Add request body fields as a JSON object", doctor: true, sample: '{"example":true}' },
  { flags: ["--auth"], value: "<mode>", section: "Advanced", description: `Use ${CLI_AUTH_MODES.join(", ")}`, doctor: true, sample: "none" },
  { flags: ["--max-turns"], value: "<n>", section: "Advanced", description: "Stop after n agent rounds", doctor: true, sample: "2" },
  { flags: ["--max-output"], value: "<n>", section: "Advanced", description: "Cap output tokens per response", doctor: true, sample: "1024" },
  { flags: ["--context-window"], value: "<n>", section: "Advanced", description: "Override the model's context window", doctor: true, sample: "8192" },
  { flags: ["--max-concurrent-tools"], value: "<n>", section: "Advanced", description: "Cap tools that run in parallel", doctor: true, sample: "4" },
  { flags: ["--env-file"], value: "<path>", section: "Advanced", description: "Load environment variables (repeatable)", doctor: true, sample: ".env.local" },
  { flags: ["--extension"], value: "<module>", section: "Advanced", description: "Load a local extension (repeatable)", doctor: true, sample: "./extension.ts" },
];

/** Align one help label with the shared description column. */
function row(label: string, description: string): string {
  return `  ${label.padEnd(27)}${label.length >= 27 ? "  " : ""}${description}`;
}

/** Group the selected command's option rows in the documented section order. */
function optionSections(doctor: boolean): string[] {
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const options = CLI_OPTIONS.filter((option) => option.section === section && (!doctor || option.doctor));
    if (options.length === 0) continue;
    lines.push("", section);
    for (const option of options) {
      const label = option.flags.join(", ") + (option.value ? ` ${option.value}` : "");
      lines.push(row(label, doctor ? option.doctorDescription ?? option.description : option.description));
    }
  }
  return lines;
}

/** Format complete main-command help as plain text with a final newline. */
export function formatHelp(): string {
  return [
    "schway — a lean, fast coding agent for your terminal", "", "Usage",
    row("schway", "Start an interactive session"),
    row('schway -p "<task>" [--approval <auto|read-only>]', "Run one task"),
    row("schway doctor", "Check your setup"),
    ...optionSections(false), "", "Examples",
    '  schway -p "explain src/agent" --json',
    "  schway --resume <id>",
    '  schway --provider openai --model <id> -p "fix the failing test"',
    '  schway --add-dir ../shared -p "compare the two APIs"',
    "  schway doctor --json", "",
  ].join("\n");
}

/** Format diagnostic-only help without reading settings or running checks. */
export function formatDoctorHelp(): string {
  return [
    "schway doctor — check your setup without running a model", "", "Usage",
    "  schway doctor [options]", ...optionSections(true), "", "Examples",
    "  schway doctor", "  schway doctor --json", "",
  ].join("\n");
}
