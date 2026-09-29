import { discoverSessions, type SessionDiscovery } from "../session/jsonl.ts";
import { resolveWorkspace as canonicalWorkspace } from "../workspace/workspace.ts";
import { ModelsLayer } from "./controller-models.ts";


/** Recent-session offer and the interactive session picker. */
export abstract class SessionsLayer extends ModelsLayer {
  /** Offer the latest meaningful canonical-workspace history without activating it or opening navigation. */
  async offerRecentSession(directory: string): Promise<void> {
    const generation = ++this.recentDiscoveryGeneration;
    const session = this.session;
    const root = this.workspaceIdentity()?.root;
    let latest: SessionDiscovery | undefined;
    const roots = new Map<string, string>();
    try {
      for (let offset = 0; ; offset += 100) {
        const rows = await discoverSessions(directory, offset, this.home);
        for (const row of rows) {
          if (!row.workspaceRoot || row.id === this.sessionId || (!row.hasDraft && (row.state === "Empty history" || (!row.hasWork && !row.previewIncomplete)))) continue;
          if (this.disposed || this.session !== session || generation !== this.recentDiscoveryGeneration) return;
          if (!roots.has(row.workspaceRoot)) {
            try { roots.set(row.workspaceRoot, (await canonicalWorkspace(row.workspaceRoot)).root); }
            catch { roots.set(row.workspaceRoot, ""); }
          }
          if (roots.get(row.workspaceRoot) !== root) continue;
          if (!latest || (row.activityAt ?? row.createdAt) > (latest.activityAt ?? latest.createdAt)) latest = row;
        }
        if (this.disposed || this.session !== session || generation !== this.recentDiscoveryGeneration) return;
        if (rows.length < 100) break;
      }
      this.recentSession = latest && !latest.hasWork && !latest.hasDraft
        ? { ...latest, title: "Recent history (preview unavailable)" } : latest;
    } catch {
      if (!this.disposed && this.session === session) this.notice("Recent history is unavailable. Start a new task or use /sessions to recover saved work.");
    }
  }

  /** Mark an explicit restoration so the view explains its live workspace, branch and connection. */
  markRestored(): void { this.restored = true; }

  /** Discover bounded history once; subsequent search and paging use only the cached metadata. */
  async openSessionPicker(directory: string, resume: (id: string, signal: AbortSignal) => Promise<boolean>, more = false): Promise<boolean> {
    if (this.running || this.disposed || this.credentialEntry || this.loginCallbackValue !== undefined) return false;
    this.closeModelPicker();
    const picker = more && this.sessionPicker ? this.sessionPicker : { query: "", allWorkspaces: false, entries: [], selectedIndex: 0, offset: 0, total: 0, loading: true, hasMore: true };
    if (!more) this.sessionRows = [];
    picker.loading = true;
    this.loadMoreSessions = () => this.openSessionPicker(directory, resume, true);
    this.sessionPicker = picker;
    this.resumePickedSession = resume;
    try {
      const rows = await discoverSessions(directory, this.sessionRows.length, this.home);
      const roots = new Map<string, string>();
      for (const row of rows) {
        if (!row.workspaceRoot) continue;
        if (!roots.has(row.workspaceRoot)) {
          try { roots.set(row.workspaceRoot, (await canonicalWorkspace(row.workspaceRoot)).root); }
          catch { roots.set(row.workspaceRoot, ""); }
        }
        const canonical = roots.get(row.workspaceRoot)!;
        if (canonical) row.workspaceRoot = canonical;
        else row.state = "Workspace unavailable · restore directory before resuming";
      }
      if (this.sessionPicker !== picker || this.disposed) return false;
      this.sessionRows = [...this.sessionRows, ...rows].sort((a, b) => (b.activityAt ?? b.createdAt).localeCompare(a.activityAt ?? a.createdAt) || a.id.localeCompare(b.id));
      picker.hasMore = rows.length === 100;
      picker.loading = false;
      this.searchSessions(picker.query, true);
      return true;
    } catch (error) {
      if (this.sessionPicker === picker) { picker.loading = false; this.sessionPicker.error = `Cannot discover sessions: ${error instanceof Error ? error.message : String(error)}`; }
      return false;
    }
  }

  /** Scan the next bounded batch only on request; re-sort all discovered results by committed activity. */
  async loadMoreSessionPicker(): Promise<boolean> {
    if (!this.sessionPicker?.hasMore || this.sessionPicker.loading || !this.loadMoreSessions) return false;
    return this.loadMoreSessions();
  }

  /** Filter cached task metadata within the explicit workspace scope and reset to its first page. */
  searchSessions(query: string, refresh = false): void {
    const picker = this.sessionPicker;
    if (!picker) return;
    if (!refresh && picker.query === query.slice(0, 256)) return;
    picker.query = query.slice(0, 256);
    if (picker.loading) return;
    const terms = picker.query.toLowerCase().split(/\s+/).filter(Boolean);
    this.sessionMatches = this.sessionRows.filter(row => (picker.allWorkspaces || row.workspaceRoot === this.workspaceIdentity()?.root) && terms.every(term => `${row.title} ${row.workspaceRoot} ${row.id} ${row.state}`.toLowerCase().includes(term)));
    picker.offset = 0; picker.selectedIndex = 0; picker.total = this.sessionMatches.length;
    picker.entries = this.sessionMatches.slice(0, 8);
  }

  /** Toggle current-workspace discovery versus all retained history, including unknown or broken roots. */
  toggleSessionScope(): void {
    if (!this.sessionPicker || this.sessionPicker.loading) return;
    this.sessionPicker.allWorkspaces = !this.sessionPicker.allWorkspaces;
    this.searchSessions(this.sessionPicker.query, true);
  }

  /** Move the preview through cached results with pages of at most eight rows. */
  moveSessionPicker(delta: number): void {
    const picker = this.sessionPicker;
    if (!picker || picker.loading || !picker.total) return;
    const index = Math.max(0, Math.min(picker.total - 1, picker.offset + picker.selectedIndex + delta));
    picker.offset = Math.floor(index / 8) * 8;
    picker.selectedIndex = index - picker.offset;
    picker.entries = this.sessionMatches.slice(picker.offset, picker.offset + 8);
  }

  /** Release discovery without reading, repairing or switching any saved conversation. */
  closeSessionPicker(): void { this.sessionResumeAbort?.abort(); this.sessionResumeAbort = undefined; this.sessionPicker = undefined; this.sessionRows = []; this.sessionMatches = []; this.resumePickedSession = undefined; this.loadMoreSessions = undefined; }

  /** Resume only after explicit confirmation, retaining the picker and current runtime on failure. */
  async selectPickerSession(): Promise<boolean> {
    const picker = this.sessionPicker;
    const selected = picker?.entries[picker.selectedIndex];
    if (!picker || picker.loading || !selected || !this.resumePickedSession || this.running) return false;
    picker.loading = true;
    const abort = new AbortController();
    this.sessionResumeAbort = abort;
    try {
      const success = await this.resumePickedSession(selected.id, abort.signal);
      if (abort.signal.aborted || this.sessionPicker !== picker) return false;
      if (success) this.closeSessionPicker();
      else { picker.error = "Resume failed; the current session is unchanged. See the diagnostic below; restore unavailable files or choose another row."; picker.loading = false; }
      return success;
    } catch (error) { picker.loading = false; picker.error = error instanceof Error ? error.message : String(error); return false; }
  }
}
