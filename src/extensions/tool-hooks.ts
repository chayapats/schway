import { redactSecrets } from "../auth/secrets.ts";
import type { ToolCallContent } from "../conversation/types.ts";
import type { ExecutedToolCall } from "../tools/executor.ts";
import type { RegisteredTool } from "../tools/registry.ts";
import type { ToolDefinition, ToolExecutionResult } from "../tools/types.ts";
import type { AfterToolHook, BeforeToolHook, BeforeToolInput } from "./index.ts";
import { nonempty, object } from "./validation.ts";

interface Owned<T> { source: string; hook: T }

/** Run ordered tool waterfalls with detached data, bounded presentation, and cancellation owned by the harness. */
export class ExtensionToolHooks {
  private readonly before: Array<Owned<BeforeToolHook>> = [];
  private readonly after: Array<Owned<AfterToolHook>> = [];

  /** Bind tool interventions to the loaded runtime and its known credentials. */
  constructor(readonly signal: AbortSignal, private readonly secrets: readonly string[] = []) {}

  /** Keep native tool execution unchanged when no tool interventions are registered. */
  get active(): boolean { return Boolean(this.before.length || this.after.length); }

  /** Register an argument intervention in extension and handler registration order. */
  beforeTool(source: string, hook: BeforeToolHook): void { this.register(this.before, source, hook); }
  /** Register a result intervention in extension and handler registration order. */
  afterTool(source: string, hook: AfterToolHook): void { this.register(this.after, source, hook); }

  /** Apply argument replacements without exposing authoritative call identity, schema, or scheduling metadata. */
  async prepare(call: ToolCallContent, registered: RegisteredTool, signal: AbortSignal): Promise<unknown> {
    let args: unknown = structuredClone(call.arguments);
    for (const { source, hook } of this.before) {
      args = await this.invoke(source, "beforeTool", signal, async () => {
        const result = await hook(this.input(call, registered.definition, args, signal));
        if (result === undefined) return args;
        if (result && typeof result === "object" && "deny" in result) {
          object(result, ["deny"]);
          nonempty(result.deny, "denial explanation");
          throw new Error(`Denied: ${result.deny}`);
        }
        object(result, ["arguments"]);
        if (!("arguments" in result)) throw new Error("beforeTool requires arguments or a denial");
        const next: unknown = structuredClone(result.arguments);
        jsonArguments(next);
        const validated = registered.validate(next);
        if (!validated.ok) throw new Error(`Invalid transformed arguments for tool ${call.name}: ${validated.message}`);
        return validated.value;
      });
    }
    signal.throwIfAborted();
    return args;
  }

  /** Transform only a settled execution, preserving its original outcome on cancellation or for failure inspection. */
  async finish(call: ToolCallContent, definition: ToolDefinition, args: unknown, executed: ExecutedToolCall, signal: AbortSignal): Promise<ExecutedToolCall> {
    const original = this.snapshot(executed);
    if (signal.aborted || executed.status === "cancelled") return original;
    let current: ToolExecutionResult = { content: original.result.content, isError: original.result.isError, details: original.details };
    try {
      for (const { source, hook } of this.after) {
        current = await this.invoke(source, "afterTool", signal, async () => {
          const result = await hook({
            ...this.input(call, definition, args, signal),
            outcome: structuredClone({ ...current, status: original.status }),
          });
          if (result === undefined) return current;
          object(result, ["content", "isError", "details"]);
          if (typeof result.content !== "string" || (result.isError !== undefined && typeof result.isError !== "boolean")) {
            throw new Error("afterTool requires content text and an optional isError boolean");
          }
          return {
            content: this.safeText(result.content),
            isError: result.isError ?? current.isError,
            ...(result.details !== undefined ? { details: this.details(result.details) } : {}),
          };
        });
      }
      return {
        result: { ...original.result, content: current.content, isError: current.isError === true },
        status: current.isError === true ? "error" : "success",
        details: current.details,
      };
    } catch (error) {
      // Actual execution has already settled: cancellation must not erase its effects or advertise a replay.
      if (signal.aborted) return original;
      return {
        result: { ...original.result, isError: true, content: this.safeText(
          `Tool execution occurred; its effects may already apply. Schway did not replay the tool. Inspect the original execution outcome before retrying. afterTool processing failed: ${messageOf(error)}`,
        ) },
        status: "error",
        details: { afterToolFailure: true, execution: { status: original.status, content: original.result.content, isError: original.result.isError, details: original.details } },
      };
    }
  }

  /** Redact credentials before truncation so a boundary cannot expose a partial credential. */
  safeText(text: string): string {
    const safe = redactSecrets(text, this.secrets);
    return safe.length <= 50_000 ? safe : `${safe.slice(0, 49_920)}\n[Extension tool output truncated; narrow the request or use pagination.]`;
  }

  /** Capture an isolated view of the executable contract for one hook. */
  private input(call: ToolCallContent, definition: ToolDefinition, args: unknown, signal: AbortSignal): BeforeToolInput {
    return { ...structuredClone({ id: call.id, name: call.name, arguments: args, inputSchema: definition.inputSchema, execution: definition.execution }), signal };
  }

  /** Retain bounded original output for inspection even if a native tool's details cannot be serialized. */
  private snapshot(executed: ExecutedToolCall): ExecutedToolCall {
    let details: unknown;
    if (executed.details !== undefined) {
      try { details = this.details(executed.details); }
      catch { details = { unavailable: "Original tool details are not finite, acyclic JSON data" }; }
    }
    return { ...executed, result: { ...executed.result, content: this.safeText(executed.result.content) }, details };
  }

  /** Require JSON details, detach and redact nested keys/values, and bound their serialized size. */
  private details(value: unknown): unknown {
    const serialized = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "function" || typeof nested === "symbol" || typeof nested === "bigint" ||
        (typeof nested === "number" && !Number.isFinite(nested))) {
        throw new Error("Tool hook details must be finite, acyclic JSON data");
      }
      return nested;
    });
    /** Mask nested text and object keys after decoding JSON escapes. */
    const redact = (nested: unknown): unknown => {
      if (typeof nested === "string") return redactSecrets(nested, this.secrets);
      if (Array.isArray(nested)) return nested.map(redact);
      if (nested && typeof nested === "object") return Object.fromEntries(Object.entries(nested).map(([key, entry]) => [redactSecrets(key, this.secrets), redact(entry)]));
      return nested;
    };
    const copy: unknown = redact(JSON.parse(serialized));
    const safe = JSON.stringify(copy);
    return safe.length <= 50_000 ? copy : { truncated: true, preview: safe.slice(0, 24_000) };
  }

  /** Validate handlers while the runtime remains open without sharing request-hook activation. */
  private register<T>(list: Array<Owned<T>>, source: string, hook: T): void {
    this.signal.throwIfAborted();
    if (typeof hook !== "function") throw new Error("Tool hook must be a function");
    list.push({ source, hook });
  }

  /** Race only extension hook work against cancellation and attribute failures without suggesting automatic replay. */
  private async invoke<T>(source: string, phase: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    let abort!: () => void;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      const failure = new Error(this.safeText(`Extension "${source}" ${phase}: ${signal.aborted ? "Cancelled" : messageOf(error)}. Check this extension or disable it.`));
      if (signal.aborted) failure.name = "AbortError";
      throw failure;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}

/** Normalize thrown hook values without allowing unprintable failures to escape settlement. */
function messageOf(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "Unprintable extension failure"; }
}

/** Reject non-JSON argument replacements even when a tool schema permits arbitrary values. */
function jsonArguments(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Tool hook arguments must be finite, acyclic JSON data");
  if (!Array.isArray(value)) object(value);
  ancestors.add(value);
  for (const nested of Object.values(value)) jsonArguments(nested, ancestors);
  ancestors.delete(value);
}
