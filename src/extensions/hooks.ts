import { redactSecrets } from "../auth/secrets.ts";
import type { ContextSection } from "../context/manager.ts";
import type { UserMessage } from "../conversation/types.ts";
import type { ModelRequest } from "../model/model.ts";
import type { BeforeAgentHook, BeforeModelHook, ContextHook, ExtensionModelRequest } from "./index.ts";
import { nonempty, object, validateItems, validateSections, validateTools } from "./validation.ts";

interface Owned<T> { source: string; value: T }

/** Own sequential request interventions while keeping all accepted data detached from extension references. */
export class ExtensionHooks {
  private readonly prompts: Array<Owned<ContextSection>> = [];
  private readonly agentHooks: Array<Owned<BeforeAgentHook>> = [];
  private readonly contextHooks: Array<Owned<ContextHook>> = [];
  private readonly modelHooks: Array<Owned<BeforeModelHook>> = [];

  /** Bind initialization and execution to the owning extension lifetime and known credential redaction. */
  constructor(private readonly signal: AbortSignal, private readonly secrets: readonly string[] = []) {}

  /** Leave the native request path untouched when no prompt contributions or interventions are registered. */
  get active(): boolean { return Boolean(this.prompts.length || this.agentHooks.length || this.contextHooks.length || this.modelHooks.length); }

  /** Snapshot one prompt contribution, rejecting structural names and ambiguous extension owners. */
  registerPrompt(source: string, section: ContextSection): void {
    this.signal.throwIfAborted();
    const copy = structuredClone(section);
    validateSections([copy], [], true);
    const previous = this.prompts.find(entry => entry.value.name === copy.name);
    if (previous) throw new Error(`Prompt section "${copy.name}" conflicts between extensions "${previous.source}" and "${source}"`);
    this.prompts.push({ source, value: copy });
  }

  /** Register an initialization-time beforeAgent handler in source order. */
  beforeAgent(source: string, hook: BeforeAgentHook): void { this.register(this.agentHooks, source, hook); }
  /** Register an initialization-time dynamic context handler in source order. */
  context(source: string, hook: ContextHook): void { this.register(this.contextHooks, source, hook); }
  /** Register an initialization-time native request handler in source order. */
  beforeModel(source: string, hook: BeforeModelHook): void { this.register(this.modelHooks, source, hook); }

  /** Execute beforeAgent once, accepting only additional turn context and never user-message changes. */
  async beginTurn(message: UserMessage, signal: AbortSignal): Promise<ContextSection[]> {
    let context: ContextSection[] = [];
    for (const { source, value: hook } of this.agentHooks) {
      context = await this.invoke(source, "beforeAgent", signal, async () => {
        const result = await hook({ ...structuredClone({ message, context }), signal });
        if (result === undefined) return context;
        deny(result);
        object(result, ["context"]);
        const next: unknown = structuredClone(result.context);
        validateSections(next, context, true);
        const promptNames = new Set(this.prompts.map(entry => entry.value.name));
        if (next.some(section => promptNames.has(section.name))) throw new Error("turn context must not duplicate a registered prompt section");
        return next;
      });
    }
    return context;
  }

  /** Rebuild prompt contributions and apply ordered context and model waterfalls once per logical request. */
  async prepare(request: ModelRequest, turnContext: readonly ContextSection[], signal: AbortSignal): Promise<ExtensionModelRequest> {
    const registered = structuredClone(request.tools ?? []);
    let current: ExtensionModelRequest = {
      ...structuredClone({ systemPrompt: request.systemPrompt, context: request.context, items: request.items, tools: request.tools }),
      signal,
    };
    current.context = [...current.context, ...structuredClone(this.prompts.map(entry => entry.value)), ...structuredClone(turnContext)];
    for (const { source, value: hook } of this.contextHooks) {
      const previous = current.context;
      current.context = await this.invoke(source, "context", signal, async () => {
        const result = await hook({ context: structuredClone(previous), signal });
        if (result === undefined) return previous;
        const next: unknown = structuredClone(result);
        validateSections(next, previous);
        return next;
      });
    }
    for (const { source, value: hook } of this.modelHooks) {
      const previous = current;
      current = await this.invoke(source, "beforeModel", signal, async () => {
        const { signal: _signal, ...data } = previous;
        const result = await hook({ ...structuredClone(data), signal });
        if (result === undefined) return previous;
        deny(result);
        object(result, ["systemPrompt", "context", "items", "tools", "signal"]);
        if (result.signal !== signal) throw new Error("request signal must remain the signal supplied by Schway");
        const { signal: _resultSignal, ...output } = result;
        const next = structuredClone(output);
        if (typeof next.systemPrompt !== "string") throw new Error("systemPrompt must be a string");
        validateSections(next.context, previous.context);
        validateItems(next.items);
        validateTools(next.tools, registered);
        return { systemPrompt: next.systemPrompt, context: next.context, items: next.items, tools: next.tools, signal };
      });
    }
    signal.throwIfAborted();
    return current;
  }

  private register<T>(list: Array<Owned<T>>, source: string, hook: T): void {
    this.signal.throwIfAborted();
    if (typeof hook !== "function") throw new Error("Request hook must be a function");
    list.push({ source, value: hook });
  }

  private async invoke<T>(source: string, phase: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    let abort!: () => void;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      // Promise.race also observes late rejection when an uncooperative hook outlives cancellation.
      const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      let detail = "Unprintable extension failure";
      try { detail = error instanceof Error ? error.message : String(error); } catch { /* Keep a printable fallback. */ }
      const text = redactSecrets(`Extension "${source}" ${phase}: ${signal.aborted ? "Cancelled." : detail} Check this extension or disable it and retry.`, this.secrets);
      const failure = new Error(text.length > 50_000 ? `${text.slice(0, 49_950)}\n[Extension error truncated.]` : text);
      if (signal.aborted) failure.name = "AbortError";
      throw failure;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}

function deny(value: unknown): void {
  if (value && typeof value === "object" && "deny" in value) {
    object(value, ["deny"]);
    nonempty(value.deny, "denial explanation");
    throw new Error(`Denied: ${value.deny}`);
  }
}
