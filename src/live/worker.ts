import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isSafeEndpoint, isSafeSmokeEndpoint, runLiveSmoke, type SmokeProvider, type SmokeSelection } from "./smoke.ts";

const providers: readonly string[] = ["openai-api-key", "compatible", "codex"];
const safeId = /^[a-zA-Z0-9._:/-]{1,100}$/;
const safeOption = /^[^\x00-\x1f\x7f]{1,200}$/;
const MAX_INPUT_BYTES = 8192;

/** Validate one private, size-limited subprocess instruction without accepting credentials or executable options. */
export function parseWorkerInput(value: unknown): Omit<SmokeSelection, "env" | "signal"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid instruction");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["provider", "model", "timeoutMs", "compatible", "workspaceRoot"].includes(key))) throw Error("invalid instruction");
  if (!providers.includes(input.provider as string) || typeof input.model !== "string" || !safeId.test(input.model)
    || !Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 120_000
    || typeof input.workspaceRoot !== "string" || !isAbsolute(input.workspaceRoot)
    || !/^schway-live-/.test(input.workspaceRoot.split(/[/\\]/).at(-1) ?? "")) throw Error("invalid instruction");
  let compatible: SmokeSelection["compatible"];
  if (input.compatible !== undefined) {
    if (input.provider !== "compatible" || !input.compatible || typeof input.compatible !== "object" || Array.isArray(input.compatible)) throw Error("invalid instruction");
    const config = input.compatible as Record<string, unknown>;
    if (Object.keys(config).some(key => !["baseUrl", "auth", "profile", "credentialEnv", "credentialIdentity"].includes(key))
      || typeof config.baseUrl !== "string" || !isSafeEndpoint(config.baseUrl)
      || (config.auth !== "required" && config.auth !== "none")
      || !isSafeSmokeEndpoint(config.baseUrl, config.auth)
      || ["profile", "credentialIdentity"].some(key => config[key] !== undefined && (typeof config[key] !== "string" || !safeOption.test(config[key])))
      || (config.credentialEnv !== undefined && (typeof config.credentialEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialEnv)))) throw Error("invalid instruction");
    compatible = config as SmokeSelection["compatible"];
  }
  if (input.provider === "compatible" && !compatible) throw Error("invalid instruction");
  return { enabled: true, providers: [input.provider as SmokeProvider], models: { [input.provider as string]: input.model },
    timeoutMs: input.timeoutMs as number, revision: "unknown", workspaceRoot: input.workspaceRoot, compatible };
}

/** Consume only a bounded private stdin instruction, then execute the selected native Schway loop. */
export async function runWorker(input: ReadableStream<Uint8Array>, env: Record<string, string | undefined>): Promise<string> {
  const reader = input.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_INPUT_BYTES) throw Error("instruction too large");
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  const selection = parseWorkerInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  let modelStarted = false;
  const report = await runLiveSmoke({ ...selection, env }, { onModelStarted: () => {
    if (modelStarted) return;
    // Empty private evidence lets the supervisor classify a hard stream timeout after reaping.
    writeFileSync(join(selection.workspaceRoot!, ".model-started"), "", { flag: "wx", mode: 0o600 });
    modelStarted = true;
  } });
  return JSON.stringify(report.scenarios[0]);
}

if (import.meta.main) {
  try {
    const output = await runWorker(Bun.stdin.stream(), process.env);
    // One bounded line lets the supervisor kill an unsettled stream without waiting for process exit.
    process.stdout.write(`${output}\n`);
  } catch {
    // Neither raw provider exceptions nor potentially secret-bearing instructions are printed.
    process.exitCode = 1;
  }
}
