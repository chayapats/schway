import type { SessionRecord } from "../conversation/types.ts";
import type { Session } from "../session/session.ts";
import type { SessionEntry } from "../session/branches.ts";
import { webFetchPreviewText } from "./transcript-format.ts";

/** Maximum tree nodes rendered in one snapshot; older nodes are pinned around root, heads and selection. */
export const MAX_BRANCH_TREE_NODES = 200;

/** Maximum characters kept in one tree preview; session data stays complete. */
export const MAX_BRANCH_TREE_PREVIEW_CHARS = 120;

/** Maximum branches listed in one tree snapshot, matching the textual /branch list cap. */
export const MAX_BRANCH_TREE_BRANCHES = 50;

/** Maximum transcript rows shown in a branch preview pane; durable history stays complete. */
export const MAX_BRANCH_TREE_PREVIEW_ENTRIES = 8;

/** Durable entry kind shown in the interactive branch tree. */
export type BranchTreeEntryKind = "root" | "user" | "assistant" | "tool_result" | "compaction";

/** One parent/child conversation node with stable-ID selection and bounded preview. */
export interface BranchTreeNode {
  /** Stable entry ID or conversation root ID; selection never resolves labels or prefixes. */
  id: string;
  parentId?: string;
  depth: number;
  kind: BranchTreeEntryKind;
  /** Bounded one-line preview of the entry; never the full durable content. */
  preview: string;
  /** True when the node is a complete-turn boundary eligible for forking. */
  isForkPoint: boolean;
  /** True when at least one saved branch head points here. */
  isHead: boolean;
  /** Stable branch IDs whose head is this node, in branch-list order. */
  headBranchIds: readonly string[];
  /** True when this node is the durable active branch head. */
  isActiveHead: boolean;
  childCount: number;
}

/** One saved branch row with stable-ID selector and bounded head preview. */
export interface BranchTreeBranchRow {
  /** Stable branch selector; labels are never selectors. */
  id: string;
  name?: string;
  active: boolean;
  headId: string;
  entryCount: number;
  /** Bounded preview of the head entry or root. */
  preview: string;
}

/** Renderer-free branch-tree snapshot with preview-only selection separate from the durable head. */
export interface BranchTreeSnapshot {
  /** Stable branch selected for an explicit continue action; absent for a new fork. */
  selectedBranchId?: string;
  branchOffset?: number;
  totalBranchCount?: number;
  activeBranchLabel?: string;
  rootId: string;
  activeBranchId: string;
  branches: readonly BranchTreeBranchRow[];
  /** Bounded depth-first nodes; see truncated and totalNodeCount for scale. */
  nodes: readonly BranchTreeNode[];
  /** True when nodes were capped and totalNodeCount exceeds nodes.length. */
  truncated: boolean;
  /** Preview-only selection; changing it never changes model context or persistence. */
  selectedId: string;
  /** Reachable node count (root plus durable entries) before capping. */
  totalNodeCount: number;
}

/** Build a bounded one-line preview for one durable record or the empty root; a web_fetch result shows its display-safe form. */
export function branchTreePreviewForRecord(item: SessionRecord | undefined, limit: number = MAX_BRANCH_TREE_PREVIEW_CHARS, toolCall?: { name: string; arguments: unknown }): string {
  const bound = Math.max(1, Math.floor(limit));
  if (!item) {
    const root = "(empty conversation root)";
    return root.length <= bound ? root : `${root.slice(0, bound)}…`;
  }
  const oneLine = (text: string): string => {
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return "(empty)";
    return collapsed.length <= bound ? collapsed : `${collapsed.slice(0, bound)}…`;
  };
  if (item.type === "user") return oneLine(item.content.filter(block => block.type === "text").map(block => block.text).join(" ")) || "(empty)";
  if (item.type === "assistant") {
    const text = item.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join(" ");
    if (text.trim()) return oneLine(text);
    const calls = item.content.filter(block => block.type === "tool_call");
    if (calls.length) {
      const names = calls.map(block => (block as { name: string }).name).join(", ");
      return oneLine(`tool call ${names}`);
    }
    return "(reasoning)";
  }
  if (item.type === "tool_result") {
    if (toolCall?.name !== "web_fetch") return oneLine(item.content);
    const url = (toolCall.arguments as { url?: unknown } | null)?.url;
    return oneLine(webFetchPreviewText(item.content, typeof url === "string" ? url : undefined, bound));
  }
  if (item.type === "turn_undo") return oneLine(`Undid turn ${item.turnNumber}`);
  return oneLine(`Compacted: ${item.summary}`);
}

/** Walk one entry to the root through durable parents, rejecting missing links without choosing another path. */
export function branchTreeAncestryRecords(session: Session, entryId: string): SessionRecord[] {
  if (entryId === session.rootId) return [];
  const byId = new Map(session.entries.map(entry => [entry.item.id, entry]));
  const reversed: SessionRecord[] = [];
  const seen = new Set<string>();
  let id = entryId;
  while (id !== session.rootId) {
    if (seen.has(id)) throw new Error(`Session ancestry cycle at ${id}`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing session parent or head: ${id}`);
    reversed.push(entry.item);
    id = entry.parentId;
  }
  return reversed.reverse();
}

/** Build a bounded depth-first tree with stable IDs, pinning root, heads and selection when capped. */
export function buildBranchTreeSnapshot(session: Session, selectedId?: string, limits?: { maxNodes?: number; previewChars?: number; maxBranches?: number }): BranchTreeSnapshot {
  const maxNodes = Math.max(1, Math.floor(limits?.maxNodes ?? MAX_BRANCH_TREE_NODES));
  const previewChars = Math.max(1, Math.floor(limits?.previewChars ?? MAX_BRANCH_TREE_PREVIEW_CHARS));
  const maxBranches = Math.max(1, Math.floor(limits?.maxBranches ?? MAX_BRANCH_TREE_BRANCHES));
  const branches = session.listBranches();
  const entries = session.entries;
  const byId = new Map(entries.map(entry => [entry.item.id, entry]));
  const itemById = new Map(entries.map(entry => [entry.item.id, entry.item] as const));
  const active = branches.find(branch => branch.id === session.activeBranchId);
  if (!active) throw new Error(`Missing session parent or head: ${session.activeBranchId}`);
  const activeHeadId = active.headId;
  const forkPoints = new Set<string>();
  for (const branch of branches) for (const point of branch.forkPoints) forkPoints.add(point);
  const heads = new Map<string, string[]>();
  for (const branch of branches) {
    const list = heads.get(branch.headId);
    if (list) list.push(branch.id);
    else heads.set(branch.headId, [branch.id]);
  }
  const children = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.parentId);
    if (list) list.push(entry);
    else children.set(entry.parentId, [entry]);
  }
  const toolCalls = new Map<string, { name: string; arguments: unknown }>();
  for (const item of itemById.values()) if (item.type === "assistant") for (const block of item.content) if (block.type === "tool_call") toolCalls.set(block.id, block);
  const preview = (item: SessionRecord | undefined) => branchTreePreviewForRecord(item, previewChars, item?.type === "tool_result" ? toolCalls.get(item.toolCallId) : undefined);
  const kindOf = (id: string): BranchTreeEntryKind => {
    if (id === session.rootId) return "root";
    const item = itemById.get(id);
    if (!item) return "user";
    if (item.type === "user") return "user";
    if (item.type === "assistant") return "assistant";
    if (item.type === "tool_result") return "tool_result";
    return "compaction";
  };
  const full: BranchTreeNode[] = [];
  const stack: Array<{ id: string; parentId?: string; depth: number }> = [{ id: session.rootId, depth: 0 }];
  const visited = new Set<string>();
  while (stack.length) {
    const next = stack.pop()!;
    if (visited.has(next.id)) continue;
    visited.add(next.id);
    const kids = children.get(next.id) ?? [];
    const headIds = heads.get(next.id) ?? [];
    full.push({
      id: next.id,
      ...(next.parentId === undefined ? {} : { parentId: next.parentId }),
      depth: next.depth,
      kind: kindOf(next.id),
      preview: preview(next.id === session.rootId ? undefined : itemById.get(next.id)),
      isForkPoint: forkPoints.has(next.id),
      isHead: headIds.length > 0,
      headBranchIds: [...headIds],
      isActiveHead: next.id === activeHeadId,
      childCount: kids.length,
    });
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!;
      stack.push({ id: kid.item.id, parentId: next.id, depth: next.depth + 1 });
    }
  }
  const totalNodeCount = entries.length + 1;
  const known = (id: string): boolean => id === session.rootId || byId.has(id);
  const fallback = known(activeHeadId) ? activeHeadId : session.rootId;
  const selected = selectedId !== undefined && known(selectedId) ? selectedId : fallback;
  let nodes: BranchTreeNode[] = full;
  let truncated = full.length > maxNodes || totalNodeCount > maxNodes;
  if (full.length > maxNodes) {
    const byOrder = new Map(full.map((node, index) => [node.id, index] as const));
    const keep = new Set<string>();
    for (const id of [session.rootId, activeHeadId, selected]) {
      if (keep.size >= maxNodes) break;
      if (byOrder.has(id)) keep.add(id);
    }
    for (const id of heads.keys()) {
      if (keep.size >= maxNodes) break;
      if (byOrder.has(id)) keep.add(id);
    }
    const headRoom = Math.min(full.length, Math.max(0, maxNodes - keep.size));
    const tailStart = Math.max(0, full.length - headRoom);
    for (let i = tailStart; i < full.length && keep.size < maxNodes; i++) keep.add(full[i]!.id);
    for (let i = 0; i < full.length && keep.size < maxNodes; i++) keep.add(full[i]!.id);
    nodes = full.filter(node => keep.has(node.id));
    truncated = true;
  } else if (totalNodeCount > maxNodes) truncated = true;
  const rows: BranchTreeBranchRow[] = branches.slice(0, maxBranches).map(branch => ({
    id: branch.id,
    ...(branch.name === undefined ? {} : { name: branch.name }),
    active: branch.id === session.activeBranchId,
    headId: branch.headId,
    entryCount: branch.entryCount,
    preview: preview(branch.headId === session.rootId ? undefined : itemById.get(branch.headId) ?? undefined),
  }));
  return { rootId: session.rootId, activeBranchId: session.activeBranchId, branches: rows, nodes, truncated, selectedId: selected, totalNodeCount };
}
