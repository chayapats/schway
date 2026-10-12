import type { AssistantMessage } from "../conversation/types.ts";
import type { HostedTool } from "./model.ts";

/** Accepted `webSearch` config values: `auto` sends hosted search where the allowlist confirms the route, `off` never sends it. */
export const WEB_SEARCH_SETTINGS = ["auto", "off"] as const;

/** Hosted web search preference from config; `auto` is the default. */
export type WebSearchSetting = (typeof WEB_SEARCH_SETTINGS)[number];

/** xAI billing route an allowlist entry covers: an xAI API key or the Grok subscription login. */
export type HostedToolRoute = "api-key" | "grok";

/** One route and model admitted to a hosted tool, with the recorded evidence that admitted it. */
export interface HostedToolAllowance {
  readonly provider: "xai";
  readonly route: HostedToolRoute;
  readonly model: string;
  readonly tool: HostedTool;
  /** Where the confirmation is recorded; see docs/live-providers.md#hosted-web-search-check. */
  readonly evidence: string;
}

/**
 * Routes and models that may receive hosted tools. Unknown routes, unknown models, compatible
 * endpoints, native OpenAI and the ChatGPT subscription never appear here. An entry requires
 * recorded route/model hosted-search and replay evidence; documentation alone does not admit it.
 * No such live evidence is recorded, so both xAI API-key and Grok subscription routes stay off.
 */
export const HOSTED_TOOL_ALLOWLIST: readonly HostedToolAllowance[] = [];

/** Metadata key, inside one provider namespace of message-level `providerMetadata`, that holds kept hosted items. */
export const HOSTED_ITEMS_KEY = "hosted_items";

/** Largest serialized size in UTF-8 bytes of one kept hosted item; a larger item is neither stored nor replayed. */
export const MAX_HOSTED_ITEM_BYTES = 8 * 1024;

/** Most hosted items kept for one assistant message; later items are neither stored nor replayed. */
export const MAX_HOSTED_ITEMS = 32;

/** One kept hosted output item and the number of content blocks that preceded it in the response. */
export interface KeptHostedItem {
  readonly position: number;
  readonly item: Readonly<Record<string, unknown>>;
}

/**
 * Decide the hosted tools for a session's model once; the result depends only on the model, its
 * route, the config value and the registered function tool names, so it stays fixed for the session.
 * Absent `webSearch` sends nothing, which keeps evals, smoke runs and compaction free of hosted tools.
 */
export function resolveHostedTools(input: {
  provider: string;
  /** Billing route of an xAI adapter; undefined for every other provider. */
  route?: HostedToolRoute;
  model: string;
  webSearch?: WebSearchSetting;
  functionToolNames: readonly string[];
  /** Test seam; production uses `HOSTED_TOOL_ALLOWLIST`. */
  allowlist?: readonly HostedToolAllowance[];
}): readonly HostedTool[] {
  if (input.webSearch !== "auto" || input.provider !== "xai" || input.route === undefined) return [];
  // An extension tool with the same name wins, so the model never sees two tools called web_search.
  if (input.functionToolNames.includes("web_search")) return [];
  const allowed = (input.allowlist ?? HOSTED_TOOL_ALLOWLIST).some(entry =>
    entry.provider === input.provider && entry.route === input.route && entry.model === input.model && entry.tool === "web_search");
  return allowed ? ["web_search"] : [];
}

/** Output item types a hosted tool produces; replay sends nothing else, so metadata cannot carry other wire items. */
export const HOSTED_ITEM_TYPES: readonly string[] = ["web_search_call"];

/** True when a value is a kept hosted item: a known hosted item type, a plain object within the size cap, at a valid position. */
export function isKeptHostedItem(value: unknown): value is KeptHostedItem {
  if (!isRecord(value) || !Number.isSafeInteger(value.position) || (value.position as number) < 0) return false;
  const item = value.item;
  return isRecord(item) && typeof item.type === "string" && HOSTED_ITEM_TYPES.includes(item.type) && serializedBytes(item) <= MAX_HOSTED_ITEM_BYTES;
}

/** Read up to `MAX_HOSTED_ITEMS` valid kept hosted items from one namespace record, skipping malformed or oversized entries. */
export function keptHostedItems(namespaceRecord: unknown): KeptHostedItem[] {
  if (!isRecord(namespaceRecord) || !Array.isArray(namespaceRecord[HOSTED_ITEMS_KEY])) return [];
  return (namespaceRecord[HOSTED_ITEMS_KEY] as unknown[]).slice(0, MAX_HOSTED_ITEMS).filter(isKeptHostedItem);
}

/** Count hosted web searches kept on a committed assistant message across all provider namespaces; 0 when none. */
export function hostedSearchCount(message: Pick<AssistantMessage, "providerMetadata">): number {
  let count = 0;
  for (const record of Object.values(message.providerMetadata ?? {})) {
    for (const kept of keptHostedItems(record)) if (kept.item.type === "web_search_call") count++;
  }
  return count;
}

/** UTF-8 byte length of a value's JSON form; values that cannot be serialized count as over any cap. */
export function serializedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
