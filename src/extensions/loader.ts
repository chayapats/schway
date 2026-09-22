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

const NATIVE_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "activate_skill"]);

/** Atomically load explicit modules in source order, returning tools and their separately owned extension runtime. */
export async function loadExtensions(options: {
  modules: readonly string[];
  workspace: Workspace;
  tools: ToolRegistry;
  secrets?: readonly string[];
  home?: string;
  onDiagnostic?: (message: string) => void;
}): Promise<{ tools: ToolRegistry; runtime: ExtensionRuntime }> {
  const paths: string[] = [];
  const identities = new Set<string>();
  for (const module of options.modules) {
    try {
      const path = await realpath(resolve(options.workspace.root, module));
      if (!(await stat(path)).isFile()) {
        throw new Error("Expected a local module file");
      }
      if (identities.has(path)) {
        throw new Error(`Duplicate extension identity: ${path}`);
      }
      identities.add(path);
      paths.push(path);
    } catch (error) {
      throw extensionError(module, error);
    }
  }

  const staged = forkToolRegistry(options.tools);
  const runtime = new ExtensionRuntime({ secrets: options.secrets, onDiagnostic: options.onDiagnostic });
  try {
    const skills = paths.length ? await discoverSkills({ workspaceRoot: options.workspace.root, home: options.home }) : undefined;
    for (const path of paths) {
      try {
        const module = await import(pathToFileURL(path).href);
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
          registerCommand: (command: Parameters<ExtensionContext["registerCommand"]>[0]) => register(() => runtime.registerCommand(path, command, skills)),
          onRuntimeEvent: (listener: Parameters<ExtensionContext["onRuntimeEvent"]>[0]) => register(() => runtime.subscribe(path, listener)),
          onDispose: (cleanup: Parameters<ExtensionContext["onDispose"]>[0]) => register(() => runtime.onDispose(path, cleanup)),
        });
        try {
          await module.default(context);
          if (registrationFailure) {
            throw registrationFailure;
          }
        } finally {
          open = false;
        }
      } catch (error) {
        throw extensionError(path, error);
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
  const { name, description, execution, execute } = tool;
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
  return Object.freeze({ name, description, execution, execute, inputSchema: freezeJson(toPlainJsonSchema(tool.inputSchema)) });
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
