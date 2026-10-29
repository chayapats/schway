import type { ImageContent } from "../conversation/types.ts";
import type { HostEntryReference, HostModelIdentity, HostRunUsage } from "./index.ts";

/** Versioned, reference-only image input contract, independent of the composed release version. */
export const IMAGE_INPUT_CONTRACT = "schway.host.image-input/v1" as const;

/** Subscription route whose image support must be established explicitly. */
export type HostImageRoute = "codex" | "grok";

/** Embedder-owned evidence for both PNG and JPEG on one exact route/model; never populated by runtime inference. */
export interface HostImageProbeRecord {
  readonly contract: "schway.host.image-input/v1";
  readonly route: HostImageRoute;
  readonly model: string;
  readonly testedAt: string;
  readonly revision: string;
  readonly verdict: "pass" | "unsupported" | "inconclusive";
}

/** Fresh authorized lookup of one sanitized image; null means deleted or unavailable, and results are never cached. */
export type HostImageResolver = (image: Readonly<ImageContent>, signal?: AbortSignal) => Promise<Uint8Array | null>;

/** Explicit image admission evidence and embedder-owned bytes, captured when the host is created. */
export interface HostImageOptions {
  readonly probes: readonly HostImageProbeRecord[];
  readonly resolve: HostImageResolver;
}

/** Per-route image admission derived only from caller-supplied probe records. */
export interface HostImageRouteCapability {
  readonly route: HostImageRoute;
  readonly source: "embedder-probe-record";
  readonly passedModels: readonly string[];
}

/** Honest image rejection, without a model call or durable result; input exists only after native acceptance. */
export interface HostImagesRejected {
  readonly outcome: "images-unsupported" | "images-unavailable";
  readonly model: HostModelIdentity;
  readonly input?: HostEntryReference;
  readonly usage: HostRunUsage;
}

/** Validate and detach bounded route/model evidence without reading credentials or making live calls. */
export function imageProbeRecords(value: unknown): readonly HostImageProbeRecord[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("invalid image probe records");
  const seen = new Set<string>();
  return Object.freeze(value.map(record => {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.keys(record).some(key => !["contract", "route", "model", "testedAt", "revision", "verdict"].includes(key)) ||
        record.contract !== IMAGE_INPUT_CONTRACT || !["codex", "grok"].includes(record.route) ||
        typeof record.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(record.model) ||
        typeof record.revision !== "string" || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(record.revision) ||
        typeof record.testedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(record.testedAt) || !Number.isFinite(Date.parse(record.testedAt)) ||
        !["pass", "unsupported", "inconclusive"].includes(record.verdict)) throw new Error("invalid image probe record");
    const key = `${record.route}/${record.model}`;
    if (seen.has(key)) throw new Error("duplicate image probe record");
    seen.add(key);
    return Object.freeze({ ...record }) as HostImageProbeRecord;
  }));
}

/** Enumerate each route's exact admitted models using only explicit probe evidence. */
export function imageRouteCapabilities(probes: readonly HostImageProbeRecord[]): readonly HostImageRouteCapability[] {
  return Object.freeze((["codex", "grok"] as const).map(route => Object.freeze({ route, source: "embedder-probe-record" as const,
    passedModels: Object.freeze(probes.filter(record => record.route === route && record.verdict === "pass").map(record => record.model)) })));
}
