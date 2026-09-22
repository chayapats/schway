import type { RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { RESERVED_SKILL_NAMES, type SkillDiscovery } from "../skills/skills.ts";
import type { ExtensionCommand, ExtensionCommandContext, ExtensionEvent, ExtensionEventListener } from "./index.ts";

/** Maximum pending notifications per listener, excluding the currently executing callback. */
export const OBSERVER_QUEUE_LIMIT = 128;
/** Maximum serialized characters retained per listener, excluding its currently executing callback. */
export const OBSERVER_QUEUE_CHAR_LIMIT = 256_000;

/** Discoverable command metadata with the canonical extension source that owns it. */
export interface ExtensionCommandInfo {
  readonly name: string;
  readonly description: string;
  readonly arguments?: string;
  readonly source: string;
}

interface Observer {
  source: string;
  listener: ExtensionEventListener;
  abort: AbortController;
  queue: Array<{ event: ExtensionEvent; size: number }>;
  size: number;
  dropped: number;
  busy: boolean;
  open: boolean;
}

/** Own ordered extension capabilities and asynchronous notifications for one headless or interactive runtime. */
export class ExtensionRuntime {
  private readonly lifetime = new AbortController();
  private readonly commands = new Map<string, { info: ExtensionCommandInfo; execute: ExtensionCommand["execute"] }>();
  private readonly observers = new Set<Observer>();
  private readonly cleanups: Array<{ source: string; cleanup: () => void | Promise<void> }> = [];
  private diagnostic: (message: string) => void;
  private sessionGeneration = 0;

  /** Initialize empty registries with an out-of-band diagnostic sink and known credentials to mask. */
  constructor(private readonly options: { secrets?: readonly string[]; onDiagnostic?: (message: string) => void } = {}) {
    this.diagnostic = options.onDiagnostic ?? (() => {});
  }

  /** Signal cancellation of extension-owned work when the runtime is disposed. */
  get signal(): AbortSignal { return this.lifetime.signal; }

  /** Direct diagnostics to the active controller, returning a handle that detaches it. */
  attachDiagnostics(handler: (message: string) => void): () => void {
    this.diagnostic = handler;
    return () => {
      if (this.diagnostic === handler) this.diagnostic = this.options.onDiagnostic ?? (() => {});
    };
  }

  /** Register one validated command without letting declaration order resolve conflicting owners. */
  registerCommand(source: string, command: ExtensionCommand, skills?: SkillDiscovery): void {
    this.signal.throwIfAborted();
    if (!command || typeof command !== "object") throw new Error("Expected a command definition object");
    const { name, description, arguments: usage, execute } = command;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error("Command name must contain 1–64 lowercase letters, digits, or hyphens and start with a letter or digit");
    }
    if (RESERVED_SKILL_NAMES.includes(name)) throw new Error(`Command /${name} from extension "${source}" conflicts with Schway built-in /${name}`);
    const previous = this.commands.get(name);
    if (previous) throw new Error(`Command /${name} conflicts between extensions "${previous.info.source}" and "${source}"`);
    if (typeof description !== "string" || !description.trim() || typeof execute !== "function" || (usage !== undefined && typeof usage !== "string")) {
      throw new Error(`Command /${name} requires a description, execute function, and optional arguments string`);
    }
    const info = Object.freeze({ name, description, ...(usage !== undefined ? { arguments: usage } : {}), source });
    if (skills) this.assertNoSkillCollision(info, skills);
    this.commands.set(name, { info, execute });
  }

  /** Return source-labelled metadata in deterministic registration order without executable handlers. */
  commandList(): readonly ExtensionCommandInfo[] { return [...this.commands.values()].map(({ info }) => info); }

  /** Look up an enabled command without invoking extension code. */
  command(name: string): ExtensionCommandInfo | undefined { return this.commands.get(name)?.info; }

  /** Reject a conflicting skill in the active workspace, including ambiguous skill declarations. */
  assertNoSkillCollision(command: ExtensionCommandInfo, skills: SkillDiscovery): void {
    const sources = [
      ...skills.skills.filter((skill) => skill.name === command.name).map((skill) => skill.skillFile),
      ...skills.ambiguous.filter((skill) => skill.name === command.name).flatMap((skill) => skill.sources),
      ...skills.collisions.filter((skill) => skill.name === command.name).map((skill) => skill.source),
    ];
    if (sources.length) throw new Error(`Command /${command.name} from extension "${command.source}" conflicts with skill ${sources.map((source) => `"${source}"`).join(", ")}; rename one before invoking it.`);
  }

  /** Execute one command with bounded, redacted display output, stopping the wait when its owner cancels. */
  async executeCommand(name: string, args: string, context: ExtensionCommandContext): Promise<string | void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown extension command /${name}`);
    const signal = AbortSignal.any([context.signal, this.signal]);
    try {
      const result = await untilAborted(() => command.execute(args, Object.freeze({ ...context, signal })), signal);
      if (result !== undefined && typeof result !== "string") throw new Error("Command must return display text or undefined");
      return typeof result === "string" ? this.safeText(result) : result;
    } catch (error) {
      const detail = signal.aborted ? "Cancelled. Retry the command when ready." : messageOf(error);
      throw new Error(this.safeText(`Extension "${command.info.source}" command /${name}: ${detail}`));
    }
  }

  /** Subscribe once, returning an idempotent handle that cancels current work and clears pending events. */
  subscribe(source: string, listener: ExtensionEventListener): () => void {
    this.signal.throwIfAborted();
    if (typeof listener !== "function") throw new Error("Runtime event listener must be a function");
    const observer: Observer = { source, listener, abort: new AbortController(), queue: [], size: 0, dropped: 0, busy: false, open: true };
    this.observers.add(observer);
    return () => {
      if (!observer.open) return;
      observer.open = false;
      this.clearObserver(observer, "unsubscribed");
      this.observers.delete(observer);
    };
  }

  /** Register extension cleanup in source order, invoked once even when initialization later fails. */
  onDispose(source: string, cleanup: () => void | Promise<void>): void {
    this.signal.throwIfAborted();
    if (typeof cleanup !== "function") throw new Error("Disposal callback must be a function");
    this.cleanups.push({ source, cleanup });
  }

  /** Capture a session-scoped event sink so draining a replaced turn cannot notify the new session's observers. */
  eventPublisher(): (event: RuntimeEvent) => void {
    const generation = this.sessionGeneration;
    return (event) => { if (generation === this.sessionGeneration) this.publish(event); };
  }

  /** Queue copied, frozen native events without awaiting listener work or changing authoritative events. */
  publish(event: RuntimeEvent): void {
    if (this.signal.aborted || !this.observers.size) return;
    let copy: ExtensionEvent;
    let size: number;
    try {
      const serialized = JSON.stringify(event, (_key, value: unknown) => typeof value === "string" ? redactSecrets(value, this.options.secrets ?? []) : value);
      size = serialized.length;
      if (size > OBSERVER_QUEUE_CHAR_LIMIT) {
        for (const observer of this.observers) this.drop(observer);
        return;
      }
      copy = freeze(JSON.parse(serialized)) as ExtensionEvent;
    } catch (error) {
      for (const observer of this.observers) this.report(`Extension "${observer.source}" runtime notification dropped: cannot copy ${event.type}: ${messageOf(error)}`);
      return;
    }
    for (const observer of this.observers) {
      if (observer.queue.length >= OBSERVER_QUEUE_LIMIT || observer.size + size > OBSERVER_QUEUE_CHAR_LIMIT) {
        this.drop(observer);
        continue;
      }
      observer.queue.push({ event: copy, size });
      observer.size += size;
      if (!observer.busy) {
        observer.busy = true;
        const generation = observer.abort;
        queueMicrotask(() => { void this.deliver(observer, generation); });
      }
    }
  }

  /** Cancel the previous session's observer work while keeping exactly one registration per listener. */
  replaceSession(): void {
    this.sessionGeneration++;
    for (const observer of this.observers) this.clearObserver(observer, "session replaced");
  }

  /** Abort owned work, unsubscribe listeners, detach controller handlers, and invoke cleanup once without awaiting it. */
  dispose(): void {
    if (this.signal.aborted) return;
    this.lifetime.abort();
    for (const observer of this.observers) {
      observer.open = false;
      this.clearObserver(observer, "runtime disposed");
    }
    this.observers.clear();
    this.commands.clear();
    // Cleanup promises must not retain a destroyed controller diagnostic callback.
    this.diagnostic = this.options.onDiagnostic ?? (() => {});
    for (const { source, cleanup } of this.cleanups.splice(0)) {
      try {
        Promise.resolve(cleanup()).catch((error) => { this.report(`Extension "${source}" disposal failed: ${messageOf(error)}`); });
      } catch (error) {
        this.report(`Extension "${source}" disposal failed: ${messageOf(error)}`);
      }
    }
  }

  private async deliver(observer: Observer, generation: AbortController): Promise<void> {
    if (observer.abort !== generation) return;
    try {
      while (observer.open && observer.abort === generation && observer.queue.length) {
        const next = observer.queue.shift()!;
        observer.size -= next.size;
        try {
          const work = observer.listener(next.event, Object.freeze({ signal: generation.signal }));
          if (work !== undefined) {
            const pending = Promise.resolve(work);
            // A callback can unsubscribe itself before returning a rejected promise.
            pending.catch(() => {});
            await untilAborted(() => pending, generation.signal);
          }
        } catch (error) {
          if (!generation.signal.aborted) this.report(`Extension "${observer.source}" observer failed for ${next.event.type}: ${messageOf(error)}`);
        }
      }
    } finally {
      if (observer.abort === generation) {
        observer.busy = false;
        this.reportDrops(observer);
      }
    }
  }

  private drop(observer: Observer): void {
    observer.dropped++;
    if (observer.dropped === 1) this.report(`Extension "${observer.source}" observer dropped a runtime notification: queue limit exceeded (${OBSERVER_QUEUE_LIMIT} events / ${OBSERVER_QUEUE_CHAR_LIMIT} characters). Agent output is unaffected.`);
  }

  private reportDrops(observer: Observer): void {
    if (observer.dropped) this.report(`Extension "${observer.source}" observer dropped ${observer.dropped} runtime notification(s) in total.`);
    observer.dropped = 0;
  }

  private clearObserver(observer: Observer, reason: string): void {
    if (observer.queue.length) this.report(`Extension "${observer.source}" observer dropped ${observer.queue.length} queued runtime notification(s): ${reason}.`);
    this.reportDrops(observer);
    observer.queue = [];
    observer.size = 0;
    observer.abort.abort();
    observer.abort = new AbortController();
    observer.busy = false;
  }

  private safeText(text: string): string {
    const safe = redactSecrets(text, this.options.secrets ?? []);
    return safe.length > 50_000 ? `${safe.slice(0, 49_950)}\n[Extension output truncated; narrow the request.]` : safe;
  }

  private report(message: string): void {
    try { this.diagnostic(this.safeText(message)); } catch { /* Diagnostics cannot stop authoritative work. */ }
  }
}

/** Settle cancellation promptly and detach the abort listener even if extension work never resolves. */
async function untilAborted<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Freeze detached JSON values recursively so observers cannot mutate one another's events. */
function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Normalize extension failures without assuming Error instances. */
function messageOf(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "Unprintable extension failure"; }
}
