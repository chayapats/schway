import { toolEffect } from "../tools/types.ts";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { forkToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { toPlainJsonSchema } from "../tools/schema.ts";
import type { ToolDefinition } from "../tools/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ExtensionContext } from "./index.ts";
import { guardExtensionTool } from "./runtime.ts";
import { ExtensionRuntime } from "./host.ts";
import { discoverSkills } from "../skills/skills.ts";
import { discoverPackages } from "../packages/packages.ts";

const NATIVE_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "activate_skill"]);

/** Atomically load enabled global/project package modules then explicit modules, returning tools and their separately owned runtime. */
export async function loadExtensions(options: {
  modules: readonly string[];
  workspace: Workspace;
  tools: ToolRegistry;
  secrets?: readonly string[];
  home?: string;
  signal?: AbortSignal;
  onDiagnostic?: (message: string) => void;
}): Promise<{ tools: ToolRegistry; runtime: ExtensionRuntime }> {
  options.signal?.throwIfAborted();
  const packages = await discoverPackages({ workspaceRoot: options.workspace.root, home: options.home, signal: options.signal });
  const declarations: Array<{ path: string; source: string; packageName?: string }> = [
    ...packages.flatMap(pkg => pkg.extensions.map(path => ({ path, source: `${pkg.source}: ${path}`, packageName: pkg.name }))),
    ...options.modules.map(path => ({ path: resolve(options.workspace.root, path), source: `CLI module "${path}"` })),
  ];
  const paths: Array<{ path: string; source: string; packageName?: string }> = [];
  const identities = new Map<string, string>();
  for (const declaration of declarations) {
    try {
      const path = await realpath(declaration.path);
      if (!(await stat(path)).isFile()) throw new Error("Expected a local module file");
      const previous = identities.get(path);
      if (previous) throw new Error(`Duplicate extension identity ${path}; enabled by both ${previous} and ${declaration.source}. Remove one enablement.`);
      identities.set(path, declaration.source);
      paths.push({ ...declaration, path });
    } catch (error) {
      throw extensionError(declaration.source, error);
    }
  }
  const skills = await discoverSkills({ workspaceRoot: options.workspace.root, extraRoots: options.workspace.extraRoots, home: options.home, packages, signal: options.signal });
  options.signal?.throwIfAborted();

  const staged = forkToolRegistry(options.tools);
  const runtime = new ExtensionRuntime({ secrets: options.secrets, onDiagnostic: options.onDiagnostic });
  try {
    for (const { path, source, packageName } of paths) {
      options.signal?.throwIfAborted();
      try {
        const module = await cancellable(import(pathToFileURL(path).href), options.signal);
        options.signal?.throwIfAborted();
        if (typeof module.default !== "function") {
          throw new Error("Expected a default extension initializer function");
        }
        let open = true;
        let registrationFailure: Error | undefined;
        const register = <T>(action: () => T): T => {
          if (!open) throw extensionError(path, new Error("Extension registration is closed"));
          try {
            return action();
          } catch (error) {
            registrationFailure ??= error instanceof Error ? error : new Error(String(error));
            throw registrationFailure;
          }
        };
        const context: ExtensionContext = Object.freeze({
          signal: runtime.signal,
          registerPrompt: (section: Parameters<ExtensionContext["registerPrompt"]>[0]) => register(() => runtime.hooks.registerPrompt(path, section)),
          beforeAgent: (hook: Parameters<ExtensionContext["beforeAgent"]>[0]) => register(() => runtime.hooks.beforeAgent(path, hook)),
          context: (hook: Parameters<ExtensionContext["context"]>[0]) => register(() => runtime.hooks.context(path, hook)),
          beforeModel: (hook: Parameters<ExtensionContext["beforeModel"]>[0]) => register(() => runtime.hooks.beforeModel(path, hook)),
          /** Attribute an argument hook to this module and reject registration after initialization closes. */
          beforeTool: (hook: Parameters<ExtensionContext["beforeTool"]>[0]) => register(() => runtime.toolHooks.beforeTool(path, hook)),
          /** Attribute a result hook to this module and reject registration after initialization closes. */
          afterTool: (hook: Parameters<ExtensionContext["afterTool"]>[0]) => register(() => runtime.toolHooks.afterTool(path, hook)),
          registerTool(tool: ToolDefinition) {
            register(() => {
              staged.register(guardExtensionTool(snapshotTool(tool), path, options.secrets ?? []));
            });
          },
          registerCommand: (command: Parameters<ExtensionContext["registerCommand"]>[0]) => register(() => runtime.registerCommand(path, command, skills, packageName)),
          onRuntimeEvent: (listener: Parameters<ExtensionContext["onRuntimeEvent"]>[0]) => register(() => runtime.subscribe(path, listener)),
          onDispose: (cleanup: Parameters<ExtensionContext["onDispose"]>[0]) => register(() => runtime.onDispose(path, cleanup)),
        });
        try {
          await cancellable(Promise.resolve().then(() => module.default(context)), options.signal);
          options.signal?.throwIfAborted();
          if (registrationFailure) {
            throw registrationFailure;
          }
        } finally {
          open = false;
        }
      } catch (error) {
        throw extensionError(source, error);
      }
    }
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  return { tools: staged, runtime };
}

/** Validate runtime declarations and detach model metadata from the extension's mutable objects. */
function snapshotTool(tool: ToolDefinition): ToolDefinition {
  if (!tool || typeof tool !== "object") {
    throw new Error("Expected a tool definition object");
  }
  const { name, description, execution, execute, effect } = tool;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error("Tool name must contain 1–64 letters, digits, underscores, or hyphens");
  }
  if (NATIVE_TOOL_NAMES.has(name)) {
    throw new Error(`Tool name "${name}" is reserved by Schway`);
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`Tool "${name}" requires a nonempty description`);
  }
  if (execution !== "parallel" && execution !== "exclusive") {
    throw new Error(`Tool "${name}" execution must be parallel or exclusive`);
  }
  if (typeof execute !== "function") {
    throw new Error(`Tool "${name}" requires an execute function`);
  }
  const definition: ToolDefinition = { name, description, execution, execute, inputSchema: tool.inputSchema, ...(effect !== undefined ? { effect } : {}) };
  const declaredEffect = toolEffect(definition);
  if (declaredEffect !== "read-only" && declaredEffect !== "mutating") {
    throw new Error(`Tool "${name}" effect must be read-only or mutating`);
  }
  return Object.freeze({ ...definition, inputSchema: freezeJson(toPlainJsonSchema(definition.inputSchema)) });
}

/** Freeze detached JSON metadata so later mutation cannot diverge from the compiled validator. */
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      freezeJson(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/** Attribute all startup failures to the requested or canonical extension identity. */
function extensionError(identity: string, error: unknown): Error {
  return new Error(`Extension "${identity}": ${error instanceof Error ? error.message : String(error)}`);
}

/** Stop waiting on uncooperative initializers while closing registration and disposing staged capabilities. */
async function cancellable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Extension loading cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([task, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
