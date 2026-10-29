import { validateImageContent } from "../conversation/images.ts";
import { isDeepStrictEqual } from "node:util";
import { LOCAL_DATE_SECTION_NAME } from "../context/date-section.ts";
import type { ContextSection } from "../context/manager.ts";
import type { ConversationItem } from "../conversation/types.ts";
import type { ModelTool } from "../model/model.ts";

const STRUCTURAL_NAMES = new Set(["environment", "summary", "project-instructions", "available-skills", "active-skill", LOCAL_DATE_SECTION_NAME]);

/** Validate named sections, preventing duplicate names and loss of existing structural identities. */
export function validateSections(value: unknown, previous: readonly ContextSection[] = [], additionsOnly = false): asserts value is ContextSection[] {
  if (!Array.isArray(value)) throw new Error("context must be a list of named sections");
  const names = new Set<string>();
  for (const section of value) {
    object(section, ["name", "content"]);
    nonempty(section.name, "section name");
    if (typeof section.content !== "string") throw new Error("section content must be a string");
    if (names.has(section.name)) throw new Error(`duplicate context section "${section.name}"`);
    names.add(section.name);
    if (additionsOnly && STRUCTURAL_NAMES.has(section.name)) throw new Error(`context section "${section.name}" is reserved by Schway`);
  }
  for (const section of previous) {
    if (!names.has(section.name)) throw new Error(`context must retain named section "${section.name}"`);
  }
  if (additionsOnly && !isDeepStrictEqual(value.slice(0, previous.length), previous)) {
    throw new Error("beforeAgent may only append turn context; retain preceding sections unchanged");
  }
}

/** Require model-facing tools to be a duplicate-free selection of unchanged registered definitions. */
export function validateTools(value: unknown, registered: readonly ModelTool[]): asserts value is ModelTool[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("tools must be a list of registered definitions");
  const names = new Set<string>();
  for (const tool of value) {
    object(tool, ["name", "description", "inputSchema"]);
    nonempty(tool.name, "tool name");
    if (names.has(tool.name) || !registered.some((native) => isDeepStrictEqual(native, tool))) {
      throw new Error(`tool "${tool.name}" must select an unchanged registered definition exactly once`);
    }
    names.add(tool.name);
  }
}

/** Validate native conversation shapes and complete call/result groups before any adapter sees hook output. */
export function validateItems(value: unknown): asserts value is ConversationItem[] {
  if (!Array.isArray(value)) throw new Error("items must be a native conversation list");
  const pending = new Set<string>();
  for (const item of value) {
    object(item, ["type", "id", "content", "providerMetadata", "toolCallId", "isError", "telemetry"]);
    nonempty(item.id, "item id");
    // Harness telemetry may ride along on assistant and tool items; adapters never send it.
    metadata(item.telemetry);
    if (item.type === "tool_result") {
      object(item, ["type", "id", "toolCallId", "content", "isError", "telemetry"]);
      nonempty(item.toolCallId, "toolCallId");
      if (typeof item.content !== "string" || typeof item.isError !== "boolean" || !pending.delete(item.toolCallId)) {
        throw new Error("tool results must have text, an isError boolean, and match one preceding tool call");
      }
      continue;
    }
    if (pending.size) throw new Error("conversation must settle each tool call before the next message");
    if (item.type !== "user" && item.type !== "assistant") throw new Error("items must contain only native user, assistant, or tool_result records");
    object(item, item.type === "user" ? ["type", "id", "content"] : ["type", "id", "content", "providerMetadata", "telemetry"]);
    metadata(item.providerMetadata);
    if (!Array.isArray(item.content)) throw new Error("message content must be native content blocks");
    for (const block of item.content) {
      if (item.type === "user" && block?.type === "image") { validateImageContent(block); continue; }
      object(block, ["type", "text", "id", "name", "arguments", "providerMetadata"]);
      if (block.type === "text" || (item.type === "assistant" && block.type === "thinking")) {
        object(block, block.type === "text" ? ["type", "text"] : ["type", "text", "providerMetadata"]);
        if (typeof block.text !== "string") throw new Error("text and thinking blocks require a text string");
        metadata(block.providerMetadata);
      } else if (item.type === "assistant" && block.type === "tool_call") {
        object(block, ["type", "id", "name", "arguments", "providerMetadata"]);
        nonempty(block.id, "tool call id");
        nonempty(block.name, "tool call name");
        if (pending.has(block.id) || !("arguments" in block)) throw new Error("tool calls require unique ids and arguments");
        json(block.arguments);
        metadata(block.providerMetadata);
        pending.add(block.id);
      } else throw new Error("unsupported native content block");
    }
  }
  if (pending.size) throw new Error("conversation contains unresolved tool calls");
}

/** Require a plain native object and reject extra fields such as provider wire payloads. */
export function object(value: unknown, keys?: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("expected a plain native object");
  }
  if (keys && Object.keys(value).some(key => !keys.includes(key))) throw new Error(`unsupported field; expected only ${keys.join(", ")}`);
}

/** Require nonempty names, identifiers, and denial explanations. */
export function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
}

/** Accept absent metadata or require a plain object containing valid JSON values. */
function metadata(value: unknown): void {
  if (value === undefined) return;
  object(value);
  json(value);
}

/** Reject non-JSON values, nonfinite numbers, and cycles while allowing shared acyclic references. */
function json(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("native metadata and arguments must be finite, acyclic JSON data");
  if (!Array.isArray(value)) object(value);
  ancestors.add(value);
  for (const child of Object.values(value)) json(child, ancestors);
  ancestors.delete(value);
}
