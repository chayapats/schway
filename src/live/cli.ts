import { isSafeEndpoint, runLiveSmoke, type SmokeProvider, type SmokeSelection } from "./smoke.ts";

const PROVIDERS: readonly SmokeProvider[] = ["anthropic", "openai-api-key", "compatible", "codex"];
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
/** Argument parser that never inspects the environment or OS credential store. */
export function parseLiveArgs(argv: readonly string[]): { selection: Omit<SmokeSelection, "env" | "revision"> } | { error: string } {
  const selection: Omit<SmokeSelection, "env" | "revision"> = {
    enabled: false, providers: [], timeoutMs: 30_000, models: {},
  };
  let url: string | undefined;
  let auth: "required" | "none" = "required";
  let profile: string | undefined;
  let credentialEnv: string | undefined;
  let credentialIdentity: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enable-live") { selection.enabled = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) return { error: "Missing value for live smoke option." };
    if (flag === "--provider") {
      const providers = value === "all" ? PROVIDERS : value.split(",");
      if (providers.length === 0 || providers.some(p => !PROVIDERS.includes(p as SmokeProvider))) return { error: "Unknown provider selection." };
      selection.providers = [...new Set([...selection.providers, ...providers as SmokeProvider[]])];
    } else if (flag === "--model") {
      const separator = value.indexOf("=");
      const provider = value.slice(0, separator) as SmokeProvider;
      const id = value.slice(separator + 1);
      if (separator < 1 || !PROVIDERS.includes(provider) || !SAFE_ID.test(id)) return { error: "Use --model provider=model-id with a valid provider and model ID." };
      selection.models![provider] = id;
    } else if (flag === "--base-url") {
      if (!isSafeEndpoint(value)) return { error: "Compatible endpoint must be an HTTP(S) URL without userinfo, query, or fragment." };
      url = new URL(value).href;
    } else if (flag === "--auth" && (value === "required" || value === "none")) auth = value;
    else if (flag === "--timeout-ms" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 120_000) selection.timeoutMs = Number(value);
    else if (flag === "--profile") profile = value;
    else if (flag === "--credential-env" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) credentialEnv = value;
    else if (flag === "--credential-identity") credentialIdentity = value;
    else return { error: "Invalid live smoke option or value." };
  }
  if (selection.providers.length === 0) return { error: "Select --provider anthropic|openai-api-key|compatible|codex|all (or a comma-separated list)." };
  if (selection.models && Object.keys(selection.models).some(p => !selection.providers.includes(p as SmokeProvider))) return { error: "Model override must target a selected provider." };
  if (selection.providers.includes("compatible") && !url && selection.enabled) return { error: "Select --base-url for the compatible endpoint." };
  if ((url || auth !== "required" || profile || credentialEnv || credentialIdentity) && !selection.providers.includes("compatible")) return { error: "Compatible connection options require --provider compatible." };
  if (url) selection.compatible = { baseUrl: url, auth, profile, credentialEnv, credentialIdentity };
  return { selection };
}

/** Run the explicit opt-in command, returning 0 for pass, 2 for incomplete, or 1 for failure/usage. */
export async function runLiveCli(argv: readonly string[], io: {
  env: Record<string, string | undefined>; revision: string; signal?: AbortSignal;
  out: (text: string) => void; err: (text: string) => void;
}): Promise<number> {
  const parsed = parseLiveArgs(argv);
  if ("error" in parsed) { io.err(`${parsed.error}\nSee docs/live-providers.md.\n`); return 1; }
  const report = await runLiveSmoke({ ...parsed.selection, env: parsed.selection.enabled ? io.env : {}, revision: io.revision, signal: io.signal });
  io.out(`${JSON.stringify(report, null, 2)}\n`);
  return report.aggregate === "passed" ? 0 : report.aggregate === "incomplete" ? 2 : 1;
}

/** Read only the tested checkout revision, never user-supplied provider diagnostics. */
async function revision(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    return await proc.exited === 0 && /^[a-f0-9]{40}$/.test(text) ? text : "unknown";
  } catch { return "unknown"; }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const code = await runLiveCli(process.argv.slice(2), {
      env: process.env, revision: await revision(), signal: controller.signal,
      out: text => void process.stdout.write(text), err: text => void process.stderr.write(text),
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
