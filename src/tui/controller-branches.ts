import { formatCount } from "../text/format.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { TuiTranscriptEntry } from "./controller-types.ts";
import { type BranchTreeSnapshot, branchTreePreviewForRecord, branchTreeAncestryRecords, buildBranchTreeSnapshot } from "./branch-tree.ts";
import { buildTranscriptFromSession } from "./transcript-format.ts";
import { SessionsLayer } from "./controller-sessions.ts";


/** Conversation branch commands and the interactive branch tree. */
export abstract class BranchesLayer extends SessionsLayer {
  /** List saved branch identities or change the selected ancestry while all controller work is idle. */
  branchCommand(args: string): boolean {
    const [action, id, ...label] = args.trim().split(/\s+/);
    if ((action === "tree" || action === "show") && id === undefined) {
      if (this.disposed) return false;
      // The hint row shows the tree keys while it is open, so the transcript gets no notice that would go stale after Esc.
      this.openBranchTree();
      return true;
    }
    if (action === "list" && id === undefined) {
      let branches;
      try { branches = this.session.listBranches(); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return false; }
      const lines = [`Conversation root: ${this.session.rootId}`, "Branches · /branch switch <branch-id> continue:"];
      for (const branch of branches.slice(0, 50)) {
        lines.push(`${branch.active ? "*" : "-"} ${branch.id}${branch.name ? ` (${branch.name})` : ""}: head ${branch.headId}, ${formatCount(branch.entryCount, "entry", "entries")}`);
        lines.push(`  Recent complete-turn entries: ${branch.forkPoints.slice(-12).join(", ")}`);
      }
      if (branches.length > 50) lines.push("More branches available · /branch tree browse");
      this.notice(lines.join("\n").slice(0, 50_000));
      return true;
    }
    if (this.disposed) return false;
    if (this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    if (!id || (action !== "fork" && action !== "switch") || (action === "switch" && label.length)) {
      this.fail("Usage: /branch list | /branch tree | /branch fork <entry-id> [name] | /branch switch <branch-id>. Branches do not undo file changes.");
      return false;
    }
    try {
      if (action === "fork") this.session.forkBranch(id, label.length ? label.join(" ") : undefined);
      else this.session.selectBranch(id);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId} · Enter send`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Open the interactive branch tree with preview-only selection at the durable active head. */
  openBranchTree(): boolean {
    if (this.preferences) return false;
    if (this.disposed) return false;
    if (!this.branchTreeOpen) {
      this.branchTreeOpen = true;
      this.branchTreeSelectedBranchId = this.session.activeBranchId;
      this.branchTreeSelectedId = this.session.activeBranchId ? this.activeHeadId() ?? this.session.rootId : this.session.rootId;
      this.branchTreeCache = undefined;
    }
    return true;
  }

  /** Close the branch tree without changing the durable active branch. */
  closeBranchTree(): void {
    this.branchTreeOpen = false;
    this.branchTreeCache = undefined;
  }

  /** True while the branch-tree browser is open; previewing never changes model context. */
  isBranchTreeOpen(): boolean { return this.branchTreeOpen; }

  /** Drop the cached tree so the next snapshot rebuilds from durable branches. */
  refreshBranchTree(): void { this.branchTreeCache = undefined; }

  /** Return the bounded tree snapshot, rebuilding only after branch changes or selection moves. */
  branchTreeSnapshot(): BranchTreeSnapshot | undefined {
    if (!this.branchTreeOpen) return undefined;
    const built = this.buildBranchTree();
    if (typeof built === "string") throw new Error(built);
    return built;
  }

  /** Move preview selection within visible nodes, clamping at the ends without persisting. */
  moveBranchTreeSelection(delta: number): boolean {
    if (!this.branchTreeOpen || this.disposed || !Number.isFinite(delta) || delta === 0) return false;
    const tree = this.currentBranchTree();
    if (!tree || !tree.nodes.length) return false;
    const index = tree.nodes.findIndex(node => node.id === tree.selectedId);
    const current = index === -1 ? (delta > 0 ? -1 : tree.nodes.length) : index;
    const next = Math.min(tree.nodes.length - 1, Math.max(0, current + Math.trunc(delta)));
    if (next === index) return false;
    return this.selectBranchTreeNode(tree.nodes[next]!.id);
  }

  /** Jump preview selection to the next or previous complete-turn fork point without persisting. */
  focusBranchTreeForkPoint(direction: 1 | -1): boolean {
    if (!this.branchTreeOpen || this.disposed) return false;
    const tree = this.currentBranchTree();
    if (!tree || !tree.nodes.length) return false;
    const eligible = new Set(this.session.listBranches().flatMap(branch => branch.forkPoints));
    const points = [this.session.rootId, ...this.session.entries.map(entry => entry.item.id)].filter(id => eligible.has(id));
    if (!points.length) return false;
    const current = points.indexOf(tree.selectedId);
    const next = current < 0 ? 0 : (current + direction + points.length) % points.length;
    return this.selectBranchTreeNode(points[next]!);
  }

  /** Move preview selection to one stable branch head without persisting a switch. */
  focusBranchTreeBranch(branchId: string): boolean {
    if (!this.branchTreeOpen || this.disposed || !branchId) return false;
    let headId: string | undefined;
    try { headId = this.session.listBranches().find(branch => branch.id === branchId)?.headId; }
    catch { return false; }
    if (!headId) return false;
    if (!this.selectBranchTreeNode(headId)) return false;
    this.branchTreeSelectedBranchId = branchId;
    this.branchTreeCache = undefined;
    return true;
  }

  /** Select one stable entry or root ID for preview, rejecting ancestry-broken IDs without moving selection. */
  selectBranchTreeNode(id: string): boolean {
    if (!this.branchTreeOpen || this.disposed || !id) return false;
    if (id !== this.session.rootId) {
      try { branchTreeAncestryRecords(this.session, id); }
      catch { return false; }
    }
    this.branchTreeSelectedBranchId = undefined;
    this.branchTreeSelectedId = id;
    this.branchTreeCache = undefined;
    return true;
  }

  /** Build the side-effect-free transcript that activating one entry would show, without replaying tools. */
  previewBranchTreeNode(id?: string): readonly TuiTranscriptEntry[] {
    const target = id ?? this.branchTreeSelectedId ?? this.activeHeadId() ?? this.session.rootId;
    const records = branchTreeAncestryRecords(this.session, target);
    const transcript = buildTranscriptFromSession(records);
    if (!this.secrets.length) return transcript;
    return transcript.map(entry => ({ ...entry, text: redactSecrets(entry.text, this.secrets), toolSummary: entry.toolSummary ? redactSecrets(entry.toolSummary, this.secrets) : undefined }));
  }

  /** Switch to one stable branch ID while idle and rebuild the transcript without replaying tools. */
  activateBranchTreeBranch(branchId: string): boolean {
    if (this.disposed) return false;
    if (this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    if (!branchId) { this.fail("Choose a branch · /branch tree browse"); return false; }
    try {
      this.session.selectBranch(branchId);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId} · Enter send`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Fork one complete-turn entry while idle, selecting the new head without touching files. */
  forkBranchTreeNode(entryId: string, name?: string): boolean {
    if (this.disposed) return false;
    if (this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    const trimmed = name?.trim() || undefined;
    try {
      this.session.forkBranch(entryId, trimmed);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId} · Enter send`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Toggle between continuing an existing stable branch and creating a complete-turn fork. */
  toggleBranchTreeAction(): void {
    if (!this.branchTreeOpen) return;
    if (this.branchTreeSelectedBranchId) {
      this.branchTreeSelectedBranchId = undefined;
      this.branchTreeCache = undefined;
      const tree = this.currentBranchTree();
      if (!tree?.nodes.find(node => node.id === tree.selectedId)?.isForkPoint) this.focusBranchTreeForkPoint(-1);
    } else this.focusBranchTreeBranch(this.session.activeBranchId);
  }

  /** Browse every existing branch by stable identity, or complete-turn fork points, without activation. */
  moveBranchTreeAction(delta: number): boolean {
    if (!this.branchTreeOpen || !Number.isFinite(delta)) return false;
    if (!this.branchTreeSelectedBranchId) return this.focusBranchTreeForkPoint(delta < 0 ? -1 : 1);
    let branches;
    try { branches = this.session.listBranches(); } catch { return false; }
    if (!branches.length) return false;
    const index = Math.max(0, branches.findIndex(branch => branch.id === this.branchTreeSelectedBranchId));
    const next = Math.max(0, Math.min(branches.length - 1, index + Math.trunc(delta)));
    return this.focusBranchTreeBranch(branches[next]!.id);
  }

  /** Confirm the explicitly selected existing branch or create a named complete-turn fork. */
  confirmBranchTreeSelection(name?: string): boolean {
    if (!this.branchTreeOpen || this.disposed) return false;
    if (this.branchTreeSelectedBranchId) return this.activateBranchTreeBranch(this.branchTreeSelectedBranchId);
    return this.forkBranchTreeNode(this.branchTreeSelectedId ?? this.session.rootId, name);
  }

  /** Read the durable active head without throwing when the graph is corrupt. */
  protected activeHeadId(): string | undefined {
    try { return this.session.listBranches().find(branch => branch.id === this.session.activeBranchId)?.headId; }
    catch { return undefined; }
  }

  /** Return the cached tree, returning to the durable head when preview state is stale. */
  protected currentBranchTree(): BranchTreeSnapshot | undefined {
    if (!this.branchTreeOpen) return undefined;
    const built = this.buildBranchTree();
    return typeof built === "string" ? undefined : built;
  }

  /** Build or reuse the bounded tree, keeping selection separate from the durable head. */
  protected buildBranchTree(): BranchTreeSnapshot | string {
    if (this.branchTreeCache) return this.branchTreeCache;
    try {
      const tree = buildBranchTreeSnapshot(this.session, this.branchTreeSelectedId ?? this.activeHeadId() ?? this.session.rootId);
      const branches = this.session.listBranches();
      const activeIndex = branches.findIndex(branch => branch.active);
      const active = branches[activeIndex];
      tree.activeBranchLabel = `${activeIndex + 1}. ${active?.name ?? "Conversation path"}`;
      if (this.branchTreeSelectedBranchId) {
        const index = branches.findIndex(branch => branch.id === this.branchTreeSelectedBranchId);
        const offset = Math.max(0, index - 5);
        tree.branches = branches.slice(offset, offset + 12).map(branch => ({
          id: branch.id, name: branch.name?.replace(/\s+/g, " ").slice(0, 120), active: branch.active,
          headId: branch.headId, entryCount: branch.entryCount,
          preview: branchTreePreviewForRecord(branchTreeAncestryRecords(this.session, branch.headId).find(item => item.type === "user")),
        }));
        tree.branchOffset = offset;
        tree.totalBranchCount = branches.length;
        tree.selectedBranchId = this.branchTreeSelectedBranchId;
      }
      this.branchTreeSelectedId = tree.selectedId;
      this.branchTreeCache = tree;
      return tree;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Expose the tree for snapshots with redacted previews and a stable error string. */
  protected branchTreeForSnapshot(): { tree?: BranchTreeSnapshot; error?: string } {
    if (!this.branchTreeOpen) return {};
    // While a turn streams text deltas, keep the settled tree instead of rebuilding a huge graph per delta.
    if (this.running && this.branchTreeCache) return { tree: this.redactedBranchTree(this.branchTreeCache) };
    const built = this.buildBranchTree();
    if (typeof built === "string") return { error: built };
    return { tree: this.redactedBranchTree(built) };
  }

  /** Mask known secrets in tree previews without changing durable branch data. */
  protected redactedBranchTree(tree: BranchTreeSnapshot): BranchTreeSnapshot {
    if (!this.secrets.length) return tree;
    return {
      ...tree,
      activeBranchLabel: tree.activeBranchLabel ? redactSecrets(tree.activeBranchLabel, this.secrets) : undefined,
      branches: tree.branches.map(branch => ({ ...branch, name: branch.name ? redactSecrets(branch.name, this.secrets) : undefined, preview: redactSecrets(branch.preview, this.secrets) })),
      nodes: tree.nodes.map(node => ({ ...node, preview: redactSecrets(node.preview, this.secrets) })),
    };
  }

  /** Clear the cached tree after settled turns and successful branch operations. */
  protected invalidateBranchTreeCache(): void { this.branchTreeCache = undefined; }
}
