import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { resolveSubscriptionRoute } from "../auth/subscription-route.ts";
import { createImageContent } from "../conversation/images.ts";
import type { ConversationItem } from "../conversation/types.ts";
import { IMAGE_INPUT_CONTRACT, type HostImageProbeRecord, type HostImageRoute } from "../host/image-input.ts";
import { loadProviderModel, type FetchLike, type ProviderLoaderInput } from "../model/loader.ts";
import type { Model } from "../model/model.ts";
import { boundedSmokeFetch } from "./transport.ts";

/** Explicit opt-in settings for two bounded subscription requests, with no runtime admission side effect. */
export interface ImageInputProbeSelection {
  enabled: boolean;
  route: HostImageRoute;
  model: string;
  revision: string;
  timeoutMs: number;
}

/** Secret-free evidence for one PNG/JPEG call; answer text and wire payloads are never reported. */
export interface ImageInputProbeCall {
  mediaType: "image/png" | "image/jpeg";
  status: "pass" | "incorrect-answer" | "error" | "timeout" | "cancelled";
  httpStatus?: number;
}

/** Embedder-reviewable evidence; only two correct completed calls yield an admissible probe record. */
export interface ImageInputProbeReport {
  record: HostImageProbeRecord;
  status: "skipped" | "complete" | "failed";
  reason?: "live_disabled" | "invalid_settings" | "credentials_unavailable" | "probe_failed";
  calls: ImageInputProbeCall[];
}

/** Injectable credentials, production-adapter construction and transport for deterministic protocol checks. */
export interface ImageInputProbeDependencies {
  createStore?: () => CredentialStore;
  fetch?: FetchLike;
  createModel?: (input: ProviderLoaderInput, fetch: FetchLike) => Promise<Model>;
  signal?: AbortSignal;
}

const SAFE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_REVISION = /^[a-zA-Z0-9._:/-]{1,128}$/;

/** Probe both image formats and image replay through one selected production subscription adapter, only after opt-in. */
export async function runImageInputProbe(selection: ImageInputProbeSelection, deps: ImageInputProbeDependencies = {}): Promise<ImageInputProbeReport> {
  const report: ImageInputProbeReport = {
    record: { contract: IMAGE_INPUT_CONTRACT, route: selection.route, model: SAFE_MODEL.test(selection.model) ? selection.model : "invalid-model",
      revision: SAFE_REVISION.test(selection.revision) ? selection.revision : "unknown", testedAt: new Date().toISOString(), verdict: "inconclusive" },
    status: "skipped", reason: "live_disabled", calls: [],
  };
  if (!selection.enabled) return report;
  if (!["codex", "grok"].includes(selection.route) || !SAFE_MODEL.test(selection.model) || !SAFE_REVISION.test(selection.revision) ||
      !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1000 || selection.timeoutMs > 300_000) return { ...report, status: "failed", reason: "invalid_settings" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), selection.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  const fetch = boundedSmokeFetch({ signal, fetch: deps.fetch, maxBytes: 256 * 1024, onLimit: () => controller.abort(),
    onProgress: event => { const call = report.calls.at(-1); if (event.type === "response" && call) call.httpStatus = event.status; } });
  try {
    const base = await resolveSubscriptionRoute({ provider: selection.route, model: selection.model, maxTokens: 1024,
      store: (deps.createStore ?? createNativeCredentialStore)(), env: {}, fetch, signal });
    if ("reason" in base) return { ...report, status: "skipped", reason: "credentials_unavailable" };
    const model = await (deps.createModel ?? loadProviderModel)(base.input, fetch);
    const items: ConversationItem[] = [];
    const imageData = new Map<string, Uint8Array>();
    for (const [extension, expected] of [["png", "582731"], ["jpeg", "914026"]] as const) {
      const mediaType = `image/${extension}` as const;
      const call: ImageInputProbeCall = { mediaType, status: "error" };
      report.calls.push(call);
      signal.throwIfAborted();
      const data = new Uint8Array(await Bun.file(new URL(`./fixtures/image-probe.${extension}`, import.meta.url)).arrayBuffer());
      const image = createImageContent(`probe-${extension}`, mediaType, data);
      imageData.set(image.sha256, data);
      items.push({ type: "user", id: `probe-${extension}`, content: [
        { type: "text", text: "Read the six digits in the newest image. Reply with only those digits." }, image,
      ] });
      let answer = "", complete = false;
      for await (const event of model.stream({ systemPrompt: "Transcribe the supplied image exactly.", context: [], items, imageData, signal })) {
        if (event.type === "message_complete") {
          answer = event.message.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
          complete = true;
          items.push(event.message);
        }
      }
      signal.throwIfAborted();
      call.status = complete && answer === expected ? "pass" : "incorrect-answer";
      if (call.status !== "pass") break;
    }
    const pass = report.calls.length === 2 && report.calls.every(call => call.status === "pass");
    return { ...report, status: pass ? "complete" : "failed", reason: pass ? undefined : "probe_failed",
      record: { ...report.record, verdict: pass ? "pass" : "inconclusive" } };
  } catch {
    const call = report.calls.at(-1);
    if (call) call.status = deps.signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "error";
    const unsupported = report.calls.some(call => [400, 404, 415, 422].includes(call.httpStatus ?? 0));
    return { ...report, status: "failed", reason: "probe_failed", record: { ...report.record, verdict: unsupported ? "unsupported" : "inconclusive" } };
  } finally { clearTimeout(timer); }
}

/** Parse a selected route/model and explicit live switch without accessing accounts or the network. */
export function parseImageInputProbeArgs(argv: readonly string[]): Omit<ImageInputProbeSelection, "revision"> | null {
  let enabled = false, route: HostImageRoute | undefined, model = "", timeoutMs = 120_000;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enable-live") { enabled = true; continue; }
    const value = argv[++i];
    if (flag === "--route" && (value === "codex" || value === "grok")) route = value;
    else if (flag === "--model" && value && SAFE_MODEL.test(value)) model = value;
    else if (flag === "--timeout-ms" && value && /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 300_000) timeoutMs = Number(value);
    else return null;
  }
  return route && model ? { enabled, route, model, timeoutMs } : null;
}

if (import.meta.main) {
  const selection = parseImageInputProbeArgs(process.argv.slice(2));
  if (!selection) {
    console.error("Choose route and model · See docs/live-providers.md");
    process.exitCode = 1;
  } else {
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort); process.on("SIGTERM", abort);
    try {
      const report = await runImageInputProbe({ ...selection, revision }, { signal: controller.signal });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "complete" ? 0 : report.status === "skipped" ? 2 : 1;
    } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
  }
}
