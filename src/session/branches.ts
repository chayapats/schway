import type { SessionRecord, ToolResult } from "../conversation/types.ts";

/** One durable conversation entry and its exact parent in the session graph. */
export interface SessionEntry { readonly parentId: string; readonly item: SessionRecord }

/** A named path through saved conversation, identified by ID rather than its optional label. */
export interface SessionBranch { readonly id: string; readonly headId: string; readonly name?: string }

/** Renderer-free branch metadata and valid complete-turn fork points on its ancestry. */
export interface BranchSummary extends SessionBranch { readonly active: boolean; readonly entryCount: number; readonly forkPoints: readonly string[] }

/** Atomic durable operations that retain siblings while moving only their named branch head. */
export type BranchOperation =
  | { type: "branch_append"; version: 1; branchId: string; entries: SessionEntry[] }
  | { type: "branch_fork"; version: 1; branchId: string; headId: string; name?: string }
  | { type: "branch_select"; version: 1; branchId: string; settlements: SessionEntry[] };

/** Internal immutable graph state shared by the memory session and versioned persistence replay. */
export interface BranchState {
  readonly rootId: string;
  readonly entries: ReadonlyMap<string, SessionEntry>;
  readonly branches: ReadonlyMap<string, SessionBranch>;
  readonly activeBranchId: string;
}

/** Create the stable default branch at the empty conversation root. */
export function emptyBranchState(rootId: string): BranchState {
  if (!rootId) throw new Error("Session root ID must be nonempty");
  return { rootId, entries: new Map(), branches: new Map([["main", { id: "main", headId: rootId }]]), activeBranchId: "main" };
}

/** Walk a known head to the root, rejecting missing parents and cycles instead of choosing another path. */
export function branchAncestry(state: BranchState, headId: string): SessionEntry[] {
  const reversed: SessionEntry[] = [];
  const seen = new Set<string>();
  let id = headId;
  while (id !== state.rootId) {
    if (seen.has(id)) throw new Error(`Session ancestry cycle at ${id}`);
    seen.add(id);
    const entry = state.entries.get(id);
    if (!entry) throw new Error(`Missing session parent or head: ${id}`);
    reversed.push(entry);
    id = entry.parentId;
  }
  return reversed.reverse();
}

/** Validate path-local tool groups and compaction references, returning calls still awaiting durable results. */
export function pendingCalls(items: readonly SessionRecord[]): string[] {
  const pending = new Set<string>();
  const previous = new Map<string, SessionRecord>();
  let latestCompaction: string | undefined;
  let retainedPosition = -1;
  for (const item of items) {
    if (previous.has(item.id)) throw new Error(`Duplicate session entry ID: ${item.id}`);
    if (item.type === "tool_result") {
      if (!pending.delete(item.toolCallId)) throw new Error(`Unmatched or duplicate tool result: ${item.toolCallId}`);
    } else if (item.type === "assistant" || item.type === "user") {
      if (pending.size) throw new Error(`Unsettled tool calls before entry ${item.id}: ${[...pending].join(", ")}`);
      if (item.type === "assistant") {
        for (const block of item.content) {
          if (block.type !== "tool_call") continue;
          if (!block.id || pending.has(block.id)) throw new Error(`Ambiguous tool call ID: ${block.id}`);
          pending.add(block.id);
        }
      }
    } else {
      const firstKept = previous.get(item.firstKeptId);
      if (!firstKept || firstKept.type !== "user") throw new Error(`Compaction ${item.id} has invalid firstKeptId on this ancestry: ${item.firstKeptId}`);
      if (item.parentCompactionId !== latestCompaction) throw new Error(`Compaction ${item.id} has invalid prior summary on this ancestry: ${item.parentCompactionId ?? "missing"}`);
      const position = [...previous.keys()].indexOf(item.firstKeptId);
      if (position < retainedPosition) throw new Error(`Compaction ${item.id} rewinds its prior retained boundary`);
      retainedPosition = position;
      latestCompaction = item.id;
    }
    previous.set(item.id, item);
  }
  return [...pending];
}

/** Find every complete user-turn boundary in one validated ancestry traversal. */
export function branchForkPoints(state: BranchState, headId: string): string[] {
  const items = branchAncestry(state, headId).map(entry => entry.item);
  pendingCalls(items);
  const points = [state.rootId];
  let hasUser = false;
  let complete = false;
  for (const item of items) {
    if (item.type === "user") { hasUser = true; complete = false; }
    else if (item.type === "assistant") complete = hasUser && !item.content.some(block => block.type === "tool_call");
    else if (item.type === "tool_result") complete = false;
    if (complete) points.push(item.id);
  }
  return points;
}

/** Accept only the root or a completed user turn, including compactions following its terminal assistant. */
export function isForkBoundary(state: BranchState, headId: string): boolean {
  return branchForkPoints(state, headId).at(-1) === headId;
}

/** Validate and stage a whole operation without modifying the previous graph or publishing partial heads. */
export function applyBranchOperation(state: BranchState, operation: BranchOperation): BranchState {
  if (operation.version !== 1 || !operation.branchId) throw new Error("Invalid branch operation version or ID");
  const entries = new Map(state.entries);
  const branches = new Map(state.branches);
  let activeBranchId = state.activeBranchId;
  if (operation.type === "branch_fork") {
    if (branches.has(operation.branchId)) throw new Error(`Duplicate branch ID: ${operation.branchId}`);
    if (operation.name !== undefined && (!operation.name.trim() || operation.name.length > 80 || /[\x00-\x1f\x7f]/.test(operation.name))) throw new Error("Branch names must contain 1–80 printable characters");
    if (!isForkBoundary(state, operation.headId)) throw new Error(`Entry ${operation.headId} is not a complete user-turn boundary`);
    branches.set(operation.branchId, { id: operation.branchId, headId: operation.headId, ...(operation.name === undefined ? {} : { name: operation.name }) });
    activeBranchId = operation.branchId;
  } else {
    const branch = branches.get(operation.branchId);
    if (!branch) throw new Error(`Unknown branch ID: ${operation.branchId}`);
    if (operation.type === "branch_append" && operation.branchId !== activeBranchId) throw new Error(`Cannot append to inactive branch ${operation.branchId}`);
    let headId = branch.headId;
    const added = operation.type === "branch_append" ? operation.entries : operation.settlements;
    const path = branchAncestry(state, headId).map(entry => entry.item);
    const unresolved = pendingCalls(path);
    if (operation.type === "branch_select" && (added.length !== unresolved.length || added.some((entry, index) => entry.item.type !== "tool_result" || entry.item.toolCallId !== unresolved[index] || !entry.item.isError))) {
      throw new Error("Branch selection must settle exactly its unresolved calls");
    }
    for (const entry of added) {
      if (typeof entry.item.id !== "string" || !entry.item.id) throw new Error("Session entry ID must be nonempty text");
      if (entry.item.id === state.rootId || entries.has(entry.item.id)) throw new Error(`Duplicate session entry ID: ${entry.item.id}`);
      if (entry.parentId !== headId || entry.item.id === entry.parentId) throw new Error(`Invalid session parent ${entry.parentId} for ${entry.item.id}; expected ${headId} (missing parent, cycle, or wrong branch)`);
      const detached = freezeEntry(structuredClone(entry));
      entries.set(entry.item.id, detached);
      path.push(detached.item);
      headId = entry.item.id;
    }
    pendingCalls(path);
    branches.set(branch.id, { ...branch, headId });
    if (operation.type === "branch_select") activeBranchId = branch.id;
  }
  return { ...state, entries, branches, activeBranchId };
}

/** Build result records for interrupted calls on one ancestry without invoking their tools. */
export function interruptedSettlements(items: readonly SessionRecord[]): ToolResult[] {
  return pendingCalls(items).map(toolCallId => ({ type: "tool_result", id: crypto.randomUUID(), toolCallId,
    content: "Tool call interrupted before a result was persisted", isError: true }));
}

/** Pair appended records with consecutive parents rooted at the supplied head. */
export function linkEntries(headId: string, items: readonly SessionRecord[]): SessionEntry[] {
  return items.map(item => { const entry = { parentId: headId, item }; headId = item.id; return entry; });
}

/** Freeze detached entry data so exposed records cannot mutate validated ancestry behind the session. */
function freezeEntry<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeEntry);
    Object.freeze(value);
  }
  return value;
}
