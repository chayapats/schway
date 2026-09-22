import type { SessionRecord } from "../conversation/types.ts";
import { applyBranchOperation, branchAncestry, branchForkPoints, emptyBranchState, interruptedSettlements, linkEntries,
  type BranchOperation, type BranchState, type BranchSummary, type SessionEntry } from "./branches.ts";

/** Session-wide contextual root identities, independent of conversation history and branches. */
export interface SessionMetadata { readonly extraRoots: readonly string[] }

/** Selected conversation ancestry plus renderer-free access to durable sibling branches and session-wide metadata. */
export interface Session {
  readonly items: readonly SessionRecord[];
  readonly entries: readonly SessionEntry[];
  readonly rootId: string;
  readonly activeBranchId: string;
  readonly metadata: SessionMetadata;
  readonly busy: boolean;
  /** Persist a complete accepted attachment set without appending conversation items. */
  setExtraRoots(roots: readonly string[]): void;
  /** Validate and append one atomic batch to the selected branch, publishing after persistence succeeds. */
  append(...added: SessionRecord[]): void;
  /** Return IDs, labels, heads and valid fork boundaries for every saved branch. */
  listBranches(): BranchSummary[];
  /** Create and select an independent branch at an exact complete-turn entry or root ID while idle. */
  forkBranch(entryId: string, name?: string): string;
  /** Select an exact saved branch ID while idle and settle only its interrupted accepted calls. */
  selectBranch(branchId: string): void;
  /** Hold branch selection fixed until the returned idempotent operation release is called. */
  acquireOperation(): () => void;
}

/** Optional validated graph and durable write callbacks used by persistence adapters. */
export interface SessionStorage {
  state?: BranchState;
  writeOperation?: (operation: BranchOperation) => void;
  writeRoots?: (roots: readonly string[]) => void;
}

/** Create a session with isolated ancestry and optional writes that finish before in-memory publication. */
export function createSession(initial: readonly SessionRecord[] = [], extraRoots: readonly string[] = [], storage: SessionStorage = {}): Session {
  let state = storage.state ?? emptyBranchState(crypto.randomUUID());
  if (initial.length) state = applyBranchOperation(state, { type: "branch_append", version: 1, branchId: state.activeBranchId,
    entries: linkEntries(state.branches.get(state.activeBranchId)!.headId, initial) });
  let metadata: SessionMetadata = { extraRoots: Object.freeze([...extraRoots]) };
  let leases = 0;

  /** Publish a staged graph only after its complete durable operation has been written. */
  const commit = (operation: BranchOperation): void => {
    const next = applyBranchOperation(state, operation);
    storage.writeOperation?.(operation);
    state = next;
  };
  /** Reject branch changes while a loop or summary still owns the selected ancestry. */
  const requireIdle = (): void => { if (leases) throw new Error("Session is busy; wait for the active operation to settle before changing branches"); };

  return {
    get rootId() { return state.rootId; },
    get activeBranchId() { return state.activeBranchId; },
    get busy() { return leases > 0; },
    get metadata() { return metadata; },
    get entries() { return [...state.entries.values()]; },
    get items() { return branchAncestry(state, state.branches.get(state.activeBranchId)!.headId).map(entry => entry.item); },
    setExtraRoots(roots) {
      storage.writeRoots?.(roots);
      metadata = { extraRoots: Object.freeze([...roots]) };
    },
    append(...added) {
      if (!added.length) return;
      commit({ type: "branch_append", version: 1, branchId: state.activeBranchId,
        entries: linkEntries(state.branches.get(state.activeBranchId)!.headId, added) });
    },
    listBranches() {
      return [...state.branches.values()].map(branch => {
        const ancestry = branchAncestry(state, branch.headId);
        return { ...branch, active: branch.id === state.activeBranchId, entryCount: ancestry.length,
          forkPoints: branchForkPoints(state, branch.headId) };
      });
    },
    forkBranch(headId, name) {
      requireIdle();
      const branchId = crypto.randomUUID();
      commit({ type: "branch_fork", version: 1, branchId, headId, ...(name === undefined ? {} : { name }) });
      return branchId;
    },
    selectBranch(branchId) {
      requireIdle();
      const branch = state.branches.get(branchId);
      if (!branch) throw new Error(`Unknown branch ID: ${branchId}. Use /branch list for exact IDs; labels and prefixes are not selectors.`);
      const settlements = interruptedSettlements(branchAncestry(state, branch.headId).map(entry => entry.item));
      if (branchId === state.activeBranchId && !settlements.length) return;
      commit({ type: "branch_select", version: 1, branchId, settlements: linkEntries(branch.headId, settlements) });
    },
    acquireOperation() {
      leases++;
      let released = false;
      return () => { if (!released) { released = true; leases--; } };
    },
  };
}
