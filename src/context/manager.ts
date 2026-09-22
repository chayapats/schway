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
import { assembleSystemPrompt } from "./prompt.ts";
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
} from "../skills/skills.ts";
import type {
  CompactionRecord,
  ConversationItem,
  SessionRecord,
} from "../conversation/types.ts";
import { lookupModel } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import { resolveToolPath } from "../tools/path.ts";
import type { Workspace } from "../workspace/workspace.ts";

/** Named block of volatile context sent with a model request. */
export interface ContextSection {
  name: string;
  content: string;
}

/** Fresh system prompt, dynamic context, and durable conversation items. */
export interface PreparedContext {
  systemPrompt: string;
  context: ContextSection[];
  items: readonly ConversationItem[];
  /** Compaction record created by this prepare via pressure, if any. */
  compaction?: CompactionRecord;
}

/** Options for creating a context manager with explicit budget overrides. */
export interface ContextManagerOptions {
  home?: string;
  /** Explicit context window that outranks catalog and unknown defaults. */
  contextWindow?: number;
  /** Recent complete turns to retain; defaults to COMPACTION_KEEP_TURNS. */
  keepTurns?: number;
}

/** Options for an explicit compaction run. */
export interface CompactOptions {
  reason: CompactionReason;
  signal?: AbortSignal;
}

/** Builds a model request payload that is not persisted into session history. */
export interface ContextManager {
  /** Assemble system prompt and dynamic context; auto-compacts on pressure when a model is given. */
  prepare(
    session: Session,
    model?: Model,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedContext>;
  /** Compact oldest complete turns and append a durable record; null when noop or failed. */
  compact(
    session: Session,
    model: Model,
    options: CompactOptions,
  ): Promise<CompactionRecord | null>;
  /** Attach an explicitly invoked skill body for the next submitted turn only. */
  setActiveSkill(skill: ActiveSkill): void;
  /** Drop any active skill without touching durable history. */
  clearActiveSkill(): void;
}

/** Create a context manager bound to one workspace and optional user home. */
export function createContextManager(
  workspace: Workspace,
  options: ContextManagerOptions = {},
): ContextManager {
  const keepTurns = options.keepTurns ?? COMPACTION_KEEP_TURNS;
  let activeSkill: ActiveSkill | undefined;

  /** Resolve the model-aware context window with explicit overrides first. */
  const resolveWindow = (model: Model): number => {
    if (options.contextWindow !== undefined) {
      return options.contextWindow;
    }
    return lookupModel(model.provider, model.id).contextWindow;
  };

  /** Build volatile context sections from a durable summary. */
  const summarySections = (summary: string | undefined): ContextSection[] =>
    summary === undefined
      ? []
      : [{ name: SUMMARY_SECTION_NAME, content: summary }];

  return {
    async prepare(session, model, prepareOptions = {}) {
      const systemPrompt = await assembleSystemPrompt(options.home);
      const base: ContextSection[] = [
        {
          name: "environment",
          content: [
            `Workspace root: ${workspace.root}`,
            `Launch directory: ${workspace.launchCwd}`,
          ].join("\n"),
        },
      ];
      const instructions = await discoverAgentsInstructions({
        workspace,
        home: options.home,
        targetPaths: targetPathsFrom(workspace, session.items),
      });
      if (instructions.length > 0) {
        base.push({
          name: "project-instructions",
          content: formatAgentsInstructions(instructions),
        });
      }
      const discovered = await discoverSkillsSafe(workspace.root, options.home);
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

      let summary = getEffectiveSummary(session.items);
      let items = getEffectiveConversation(session.items);
      let compaction: CompactionRecord | undefined;

      if (model) {
        const window = resolveWindow(model);
        const estimated = estimatePreparedTokens({
          systemPrompt,
          context: [...base, ...summarySections(summary)],
          items,
        });
        if (estimated >= window * COMPACTION_PRESSURE_THRESHOLD) {
          const record = await compactInternal(session, model, {
            reason: "pressure",
            signal: prepareOptions.signal,
            keepTurns,
          });
          if (record) {
            compaction = record;
            summary = record.summary;
            items = getEffectiveConversation(session.items);
          }
        }
      }

      return {
        systemPrompt,
        context: [...base.slice(0, 1), ...summarySections(summary), ...base.slice(1)],
        items,
        ...(compaction ? { compaction } : {}),
      };
    },

    async compact(session, model, compactOptions) {
      return compactInternal(session, model, {
        reason: compactOptions.reason,
        signal: compactOptions.signal,
        keepTurns,
      });
    },

    setActiveSkill(skill: ActiveSkill): void {
      activeSkill = skill;
    },

    clearActiveSkill(): void {
      activeSkill = undefined;
    },
  };

  /** Shared compaction worker used by pressure, manual, and overflow paths. */
  async function compactInternal(
    session: Session,
    model: Model,
    compactOptions: CompactOptions & { keepTurns: number },
  ): Promise<CompactionRecord | null> {
    if (compactOptions.signal?.aborted) {
      return null;
    }
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
    const summary = await summarizeWithModel(model, inputText, compactOptions.signal);
    if (!summary) {
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
    return record;
  }
}

/** Skill metadata for the available-skills section; discovery failures degrade to no section. */
async function discoverSkillsSafe(
  workspaceRoot: string,
  home: string | undefined,
): Promise<SkillMetadata[]> {
  try {
    const discovered = await discoverSkills({ workspaceRoot, home });
    return discovered.skills;
  } catch {
    return [];
  }
}

/** Launch directory plus tool `path` / `cwd` arguments from the session. */
function targetPathsFrom(
  workspace: Workspace,
  items: readonly SessionRecord[],
): string[] {
  const paths = [workspace.launchCwd];
  for (const item of items) {
    if (item.type !== "assistant") {
      continue;
    }
    for (const block of item.content) {
      if (block.type !== "tool_call" || !isPlainObject(block.arguments)) {
        continue;
      }
      const args = block.arguments;
      if (typeof args.path === "string" && args.path.length > 0) {
        paths.push(resolveToolPath(workspace.root, args.path));
      }
      if (typeof args.cwd === "string" && args.cwd.length > 0) {
        paths.push(resolveToolPath(workspace.root, args.cwd));
      }
    }
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Call the model once for a coding summary; null on failure/cancel/empty. */
async function summarizeWithModel(
  model: Model,
  inputText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    return null;
  }
  try {
    let text = "";
    for await (const event of model.stream({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      context: [],
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
      } else if (event.type === "message_complete") {
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
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
