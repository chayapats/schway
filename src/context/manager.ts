import type { ConfigDeprecation } from "../config/deprecations.ts";
import type { ConfigDiagnosticContext } from "../config/diagnostics.ts";
import {
  discoverAgentsInstructions,
  formatAgentsInstructions,
} from "./agents.ts";
import {
  buildSummaryInputText,
  COMPACTION_KEEP_TURNS,
  COMPACTION_PRESSURE_THRESHOLD,
  type CompactionReason,
  findCompactionBoundary,
  getEffectiveConversation,
  getEffectiveSummary,
  getLatestCompaction,
  pruneForSummary,
  SUMMARY_PRUNE_CHARS,
  SUMMARY_SECTION_NAME,
  SUMMARY_SYSTEM_PROMPT,
} from "./compaction.ts";
import { formatLocalDate, LOCAL_DATE_SECTION_NAME, systemTimeZone } from "./date-section.ts";
import { assembleSystemPrompt } from "./prompt.ts";
import { shortenEarlierTurnToolResults } from "./replay.ts";
import {
  estimatePreparedTokens,
  estimateSessionTokens,
} from "./tokens.ts";
import type { ActiveSkill, SkillMetadata } from "../skills/skills.ts";
import {
  ACTIVE_SKILL_SECTION_NAME,
  AVAILABLE_SKILLS_SECTION_NAME,
  discoverSkills,
  formatActiveSkillSection,
  formatAvailableSkillsSection,
  prepareSkillInvocation,
} from "../skills/skills.ts";
import type {
  CompactionRecord,
  ConversationItem,
  SessionRecord,
} from "../conversation/types.ts";
import { lookupModel } from "../model/catalog.ts";
import type { Model, ModelUsage } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import { resolveToolPath } from "../tools/path.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { contextPolicySnapshot, sourceDocumentsText, WORKSPACE_CONTEXT_POLICY, type ContextSourceDocument, type ContextSourcePolicy } from "./policy.ts";

/** Named block of volatile context sent with a model request. */
export interface ContextSection {
  name: string;
  content: string;
  /** Request provenance only; source/summary text cannot grant native execution or discovery authority. */
  trust?: "operator" | "source" | "summary";
}

/** Fresh system prompt, dynamic context, and durable conversation items. */
export interface PreparedContext {
  systemPrompt: string;
  context: ContextSection[];
  /** Effective conversation for this request, with tool results from earlier user turns shortened for replay. */
  items: readonly ConversationItem[];
  /** Compaction record created by this prepare via pressure, if any. */
  compaction?: CompactionRecord;
  compactionOutcome?: CompactionOutcome;
}

/** Distinguish a persisted summary from an unchanged, failed, or cancelled attempt. */
export type CompactionOutcome = "completed" | "noop" | "failed" | "cancelled";

/** Options for creating a context manager with explicit budget overrides. */
export interface ContextManagerOptions {
  /** Explicit source permissions apply to preparation, activation and every compaction request; omission preserves CLI defaults. */
  policy?: ContextSourcePolicy;
  /** Explicit untrusted evidence, separate from operator prompt/sections and durable history. */
  sources?: readonly ContextSourceDocument[];
  /** Explicit trusted host prompt, replacing home/default system prompt assembly when provided. */
  systemPrompt?: string;
  /** Explicit trusted host sections included in native preparation and token budgeting. */
  sections?: readonly ContextSection[];
  /** Explicit credential context for sanitized package-backed skill diagnostics. */
  diagnosticContext?: ConfigDiagnosticContext;
  /** Use the settings reader’s legacy keys during package-backed skill discovery. */
  configDeprecations?: readonly ConfigDeprecation[];
  home?: string;
  /** Explicit context window that outranks catalog and unknown defaults. */
  contextWindow?: number;
  /** Recent complete turns to retain; defaults to COMPACTION_KEEP_TURNS. */
  keepTurns?: number;
  /** Wall clock read once per managed turn for the local-date section; defaults to the system clock. */
  clock?: { now(): number };
  /** IANA zone for the local-date section; defaults to the process's resolved zone. */
  timeZone?: string;
  /** Add the web-lookup line to the base prompt; set only when the session's built-in registry has `web_fetch`. */
  webLookupGuidance?: boolean;
}

/** Options for an explicit compaction run. */
export interface CompactOptions {
  reason: CompactionReason;
  signal?: AbortSignal;
  onOutcome?: (outcome: CompactionOutcome) => void;
}

/** Prepare volatile model context and append compaction records while preserving original session history. */
export interface ContextManager {
  /** False prevents native automatic activation-tool registration as well as direct activation. */
  readonly skillActivationAllowed?: boolean;
  /** Assemble system prompt and dynamic context; auto-compacts on pressure when a model is given. */
  prepare(
    session: Session,
    model?: Model,
    options?: { signal?: AbortSignal; onCompactionStart?: () => void },
  ): Promise<PreparedContext>;
  /** Summarize older turns and append a record, returning null for no boundary or an empty, rejected, or pre-aborted summary. */
  compact(
    session: Session,
    model: Model,
    options: CompactOptions,
  ): Promise<CompactionRecord | null>;
  /** Start the managed user turn, capturing its local date and retaining explicit activation; cleanup is fenced against later turns. */
  beginTurn(): () => void;
  /** Attach a prepared user invocation before its managed turn and invalidate pending model replacements. */
  setActiveSkill(skill: ActiveSkill): void;
  /** Load a model-eligible skill by name, replacing active context only after successful validation. */
  activateSkill(name: string, options?: { signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Drop any active skill without touching durable history. */
  clearActiveSkill(): void;
  /** Drain per-attempt summarization usage, including failed or unreported attempts. */
  takeUsage(): Array<{ usage: ModelUsage; complete: boolean }>;
}

/** Create a context manager bound to one workspace and optional user home. */
export function createContextManager(
  workspace: Workspace,
  options: ContextManagerOptions = {},
): ContextManager {
  const managed = options.policy !== undefined;
  const policy = options.policy ? contextPolicySnapshot(options.policy) : WORKSPACE_CONTEXT_POLICY;
  const sources = structuredClone(options.sources ?? []);
  const sections = structuredClone(options.sections ?? []);
  const keepTurns = options.keepTurns ?? COMPACTION_KEEP_TURNS;
  let activeSkill: ActiveSkill | undefined;
  let activationScope = {};
  // Captured once per managed turn so every round, retry and overflow recovery replays identical bytes.
  let turnDate: { content: string } | undefined;
  const summaryUsage: Array<{ usage: ModelUsage; complete: boolean }> = [];

  /** Resolve the model-aware context window with explicit overrides first. */
  const resolveWindow = (model: Model): number => {
    if (options.contextWindow !== undefined) {
      return options.contextWindow;
    }
    return lookupModel(model.provider, model.id).contextWindow;
  };

  /** Read the clock and format the local date at day granularity; a failing injected clock falls back to the system clock. */
  const captureDate = (): string => {
    let epochMs = Date.now();
    try { if (options.clock) epochMs = options.clock.now(); } catch { /* Keep the system clock reading. */ }
    return formatLocalDate({ epochMs, timeZone: options.timeZone ?? systemTimeZone() });
  };

  /** Build volatile context sections from a durable summary. */
  const summarySections = (summary: string | undefined): ContextSection[] =>
    summary === undefined
      ? []
      : [{ name: SUMMARY_SECTION_NAME, content: summary, ...(managed ? { trust: "summary" as const } : {}) }];

  return {
    get skillActivationAllowed() { return policy.skillActivation; },
    async prepare(session, model, prepareOptions = {}) {
      const systemPrompt = options.systemPrompt ?? await assembleSystemPrompt(managed ? undefined : options.home, { webLookupGuidance: options.webLookupGuidance });
      // Last Schway-owned section: a date change alters only the bytes after the shared system and project prefix.
      const dateSection: ContextSection = { name: LOCAL_DATE_SECTION_NAME, content: turnDate?.content ?? captureDate() };
      const base = await baseSections(session);

      let summary = getEffectiveSummary(session.items);
      // Request-only: the estimate, overflow recovery, hooks and adapters all see these shortened items; the session keeps full results.
      let items = shortenEarlierTurnToolResults(getEffectiveConversation(session.items));
      let compaction: CompactionRecord | undefined;
      let compactionOutcome: CompactionOutcome | undefined;

      if (model) {
        const window = resolveWindow(model);
        const estimated = estimatePreparedTokens({
          systemPrompt,
          context: [...base, ...summarySections(summary), dateSection],
          items,
        });
        if (estimated >= window * COMPACTION_PRESSURE_THRESHOLD) {
          prepareOptions.onCompactionStart?.();
          const record = await compactInternal(session, model, {
            reason: "pressure",
            signal: prepareOptions.signal,
            keepTurns,
            onOutcome: outcome => { compactionOutcome = outcome; },
          });
          if (record) {
            compaction = record;
            summary = record.summary;
            items = shortenEarlierTurnToolResults(getEffectiveConversation(session.items));
          }
        }
      }

      return {
        systemPrompt,
        context: [...base.slice(0, 1), ...summarySections(summary), ...base.slice(1), dateSection],
        items,
        ...(compaction ? { compaction } : {}),
        ...(compactionOutcome ? { compactionOutcome } : {}),
      };
    },

    async compact(session, model, compactOptions) {
      return compactInternal(session, model, {
        reason: compactOptions.reason,
        signal: compactOptions.signal,
        keepTurns,
        onOutcome: compactOptions.onOutcome,
      });
    },

    /** Capture the turn's local date, retain prepared activation, and return cleanup that cannot clear a later turn's context. */
    beginTurn() {
      const scope = activationScope = {};
      const date = turnDate = { content: captureDate() };
      return () => {
        if (turnDate === date) {
          turnDate = undefined;
        }
        if (activationScope === scope) {
          activeSkill = undefined;
          activationScope = {};
        }
      };
    },

    /** Attach the prepared user skill while invalidating pending model replacements. */
    setActiveSkill(skill: ActiveSkill): void {
      if (!policy.skillActivation) throw new Error("Skill activation disabled by policy.");
      activationScope = {};
      activeSkill = skill;
    },

    /** Validate model eligibility and replace the active body only if this activation scope remains current. */
    async activateSkill(name, activationOptions = {}) {
      activationOptions.signal?.throwIfAborted();
      if (!policy.skillActivation) return { ok: false, error: "Skill activation disabled by policy." };
      const scope = activationScope;
      const invocation = await prepareSkillInvocation({
        diagnosticContext: options.diagnosticContext,
        configDeprecations: options.configDeprecations,
        workspaceRoot: workspace.root,
        extraRoots: workspace.extraRoots,
        home: options.home,
        name,
        modelInvocation: true,
        signal: activationOptions.signal,
        ...(!policy.packages ? { packages: [] } : {}),
      });
      activationOptions.signal?.throwIfAborted();
      if (activationScope !== scope) {
        return { ok: false, error: "Skill activation belongs to a turn that has ended." };
      }
      if (!invocation.ok) {
        return invocation;
      }
      if (activeSkill?.dir !== invocation.skill.dir) {
        activeSkill = {
          name: invocation.skill.name,
          body: invocation.body,
          source: invocation.skill.displayPath,
          scope: invocation.skill.scope,
          dir: invocation.skill.dir,
        };
      }
      return { ok: true };
    },

    /** Clear volatile skill context and invalidate unfinished activation requests. */
    clearActiveSkill(): void {
      activationScope = {};
      activeSkill = undefined;
    },

    takeUsage() {
      return summaryUsage.splice(0);
    },
  };

  /** Assemble every source through the same captured policy, including requests made only for compaction. */
  async function baseSections(session: Session): Promise<ContextSection[]> {
    const base: ContextSection[] = [
      {
        name: "environment",
        content: [
          `Workspace root: ${workspace.root}`,
          `Launch directory: ${workspace.launchCwd}`,
          ...workspace.extraRoots.map(root => `Attached root: ${root}`),
          ...(workspace.extraRoots.length ? ["Relative tool paths and default bash cwd use the workspace root. Attachments supply context, not filesystem permissions."] : []),
        ].join("\n"),
      },
      ...sections.map(section => ({ ...section, ...(managed ? { trust: "operator" as const } : {}) })),
      ...(sources.length ? [{ name: "host-source-documents", content: sourceDocumentsText(sources), trust: "source" as const }] : []),
    ];
    const instructions = policy.workspaceAgents || policy.homeAgents ? await discoverAgentsInstructions({
      workspace,
      home: policy.homeAgents ? options.home : undefined,
      workspaceDiscovery: policy.workspaceAgents,
      targetPaths: targetPathsFrom(workspace, session.items),
    }) : [];
    if (instructions.length > 0) {
      base.push({
        name: "project-instructions",
        content: formatAgentsInstructions(instructions),
      });
    }
    const discovered = policy.skills ? await discoverSkillsSafe(workspace, options.home, options.configDeprecations, options.diagnosticContext, policy.packages) : [];
    const modelSkills = discovered.filter((skill) => !skill.userOnly);
    if (modelSkills.length > 0) {
      base.push({
        name: AVAILABLE_SKILLS_SECTION_NAME,
        content: formatAvailableSkillsSection(modelSkills),
      });
    }
    if (activeSkill) {
      base.push({
        name: ACTIVE_SKILL_SECTION_NAME,
        content: formatActiveSkillSection({
          name: activeSkill.name,
          source: activeSkill.source,
          body: activeSkill.body,
        }),
      });
    }

    return base;
  }

  /** Shared compaction worker used by pressure, manual, and overflow paths. */
  async function compactInternal(
    session: Session,
    model: Model,
    compactOptions: CompactOptions & { keepTurns: number },
  ): Promise<CompactionRecord | null> {
    if (compactOptions.signal?.aborted) {
      compactOptions.onOutcome?.("cancelled");
      return null;
    }
    const release = session.acquireOperation();
    let outcome: CompactionOutcome = "noop";
    try {
      const effective = getEffectiveConversation(session.items);
      const boundary = findCompactionBoundary(effective, compactOptions.keepTurns);
      if (!boundary) {
        return null;
      }
      const latest = getLatestCompaction(session.items);
      if (latest && latest.firstKeptId === boundary.firstKeptId) {
        return null;
      }
      const splitIndex = effective.findIndex(
        (item) => item.id === boundary.firstKeptId,
      );
      if (splitIndex <= 0) {
        return null;
      }
      const compacted = effective.slice(0, splitIndex);
      if (compacted.length === 0) {
        return null;
      }
      const previousSummary = getEffectiveSummary(session.items);
      const pruned = pruneForSummary(compacted, SUMMARY_PRUNE_CHARS);
      const inputText = buildSummaryInputText({
        previousSummary,
        compacted: pruned,
      });
      const tokensBefore = estimateSessionTokens(session.items);
      const managedContext = managed ? {
        systemPrompt: options.systemPrompt ? `${options.systemPrompt}\n\n${SUMMARY_SYSTEM_PROMPT}` : SUMMARY_SYSTEM_PROMPT,
        context: await baseSections(session),
      } : undefined;
      const summary = await summarizeWithModel(model, inputText, compactOptions.signal, (usage, complete) => {
        summaryUsage.push({ usage, complete });
        if (!complete) outcome = "failed";
      }, managedContext);
      if (!summary || compactOptions.signal?.aborted) {
        if (managed && !summary && !compactOptions.signal?.aborted) outcome = "failed";
        return null;
      }
      const record: CompactionRecord = {
        type: "compaction",
        id: crypto.randomUUID(),
        summary,
        firstKeptId: boundary.firstKeptId,
        tokensBefore,
        ...(latest ? { parentCompactionId: latest.id } : {}),
      };
      session.append(record);
      outcome = "completed";
      return record;
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      release();
      compactOptions.onOutcome?.(compactOptions.signal?.aborted && outcome !== "completed" ? "cancelled" : outcome);
    }
  }
}

/** Skill metadata for the available-skills section; discovery failures degrade to no section. */
async function discoverSkillsSafe(
  workspace: Workspace,
  home: string | undefined,
  configDeprecations?: readonly ConfigDeprecation[],
  diagnosticContext?: ConfigDiagnosticContext,
  packages = true,
): Promise<SkillMetadata[]> {
  try {
    const discovered = await discoverSkills({ workspaceRoot: workspace.root, extraRoots: workspace.extraRoots, home, configDeprecations, diagnosticContext,
      ...(!packages ? { packages: [] } : {}) });
    return discovered.skills;
  } catch {
    return [];
  }
}

/** Use the latest path-bearing tool batch in the current user turn, falling back to the launch directory. */
function targetPathsFrom(workspace: Workspace, items: readonly SessionRecord[]): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "user") break;
    if (item.type !== "assistant") continue;
    const paths: string[] = [];
    for (const block of item.content) {
      if (block.type !== "tool_call" || !isPlainObject(block.arguments)) continue;
      for (const key of ["path", "cwd"]) {
        const value = block.arguments[key];
        if (typeof value === "string" && value.length > 0) paths.push(resolveToolPath(workspace.root, value));
      }
      if (block.name === "bash" && !block.arguments.cwd) paths.push(workspace.root);
      if (["ls", "find", "grep"].includes(block.name) && !block.arguments.path) paths.push(workspace.root);
    }
    if (paths.length) return paths;
  }
  return [workspace.launchCwd];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Call the model once for a coding summary; null on failure/cancel/empty. */
async function summarizeWithModel(
  model: Model,
  inputText: string,
  signal?: AbortSignal,
  onUsage?: (usage: ModelUsage, complete: boolean) => void,
  managedContext?: { systemPrompt: string; context: ContextSection[] },
): Promise<string | null> {
  if (signal?.aborted) {
    return null;
  }
  let usage: ModelUsage = { inputTokens: null, outputTokens: null };
  let complete = false;
  try {
    let text = "";
    for await (const event of model.stream({
      systemPrompt: managedContext?.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
      context: managedContext?.context ?? [],
      items: [
        {
          type: "user",
          id: crypto.randomUUID(),
          content: [{ type: "text", text: inputText }],
        },
      ],
      signal,
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "message_complete") {
        complete = true;
        const completed: string[] = [];
        for (const block of event.message.content) {
          if (block.type === "text") {
            completed.push(block.text);
          }
        }
        if (completed.length > 0) {
          text = completed.join("");
        }
      }
    }
    const trimmed = text.trim();
    return complete && trimmed.length > 0 ? trimmed : null;
  } catch {
    complete = false;
    return null;
  } finally {
    onUsage?.(usage, complete && !signal?.aborted);
  }
}
