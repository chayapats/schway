import { discoverSessions, type SessionDiscovery } from "../session/jsonl.ts";
import { resolveWorkspace as canonicalWorkspace } from "../workspace/workspace.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { ModelsLayer } from "./controller-models.ts";
import type { TuiSnapshot } from "./controller-types.ts";
import { SESSION_DISCOVERY_FAILED, SESSION_LOAD_MORE_FAILED, SESSION_RESUME_FAILED } from "./session-picker-view.ts";

/** A picker resume failure with a short, reason-specific status of six words or fewer; `message` holds the full text for F2 details. */
export class SessionResumeError extends Error {
  constructor(readonly status: string, message: string) { super(message); this.name = "SessionResumeError"; }
}


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
        ? { ...latest, title: "Recent conversation" } : latest;
    } catch {
      if (!this.disposed && this.session === session) this.notice("Recent history unavailable · /sessions browse saved work");
    }
  }

  /** Mark an explicit restoration so the view explains its live workspace, branch and connection. */
  markRestored(): void { this.restored = true; }

  /**
   * Discover bounded history once; subsequent search and paging use only the cached metadata. A discovery failure stays
   * until discovery succeeds; when earlier batches loaded, it is a load-more failure that leaves those rows usable.
   */
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
        else row.state = "Workspace unavailable · Restore directory to resume";
      }
      if (this.sessionPicker !== picker || this.disposed) return false;
      this.sessionRows = [...this.sessionRows, ...rows].sort((a, b) => (b.activityAt ?? b.createdAt).localeCompare(a.activityAt ?? a.createdAt) || a.id.localeCompare(b.id));
      picker.hasMore = rows.length === 100;
      picker.loading = false;
      delete picker.discoveryError;
      if (picker.errorKind === "discovery" || picker.errorKind === "more") this.clearPickerError(picker);
      this.searchSessions(picker.query, true);
      return true;
    } catch (error) {
      if (this.sessionPicker === picker) {
        picker.loading = false;
        picker.discoveryError = redactSecrets(`Cannot discover sessions: ${error instanceof Error ? error.message : String(error)}`, this.secrets);
        if (picker.errorKind !== "resume") this.showDiscoveryError(picker);
      }
      return false;
    }
  }

  /** Scan the next bounded batch only on request; re-sort all discovered results by committed activity. */
  async loadMoreSessionPicker(): Promise<boolean> {
    if (!this.sessionPicker?.hasMore || this.sessionPicker.loading || this.sessionPicker.resuming || !this.loadMoreSessions) return false;
    return this.loadMoreSessions();
  }

  /** Filter cached task metadata within the explicit workspace scope and reset to its first page; a changed query clears a resume failure. */
  searchSessions(query: string, refresh = false): void {
    const picker = this.sessionPicker;
    if (!picker) return;
    if (!refresh && picker.query === query.slice(0, 256)) return;
    picker.query = query.slice(0, 256);
    if (picker.errorKind === "resume") this.clearPickerError(picker);
    if (picker.loading) return;
    const terms = picker.query.toLowerCase().split(/\s+/).filter(Boolean);
    this.sessionMatches = this.sessionRows.filter(row => (picker.allWorkspaces || row.workspaceRoot === this.workspaceIdentity()?.root) && terms.every(term => `${row.title} ${row.workspaceRoot} ${row.id} ${row.state}`.toLowerCase().includes(term)));
    picker.offset = 0; picker.selectedIndex = 0; picker.total = this.sessionMatches.length;
    picker.entries = this.sessionMatches.slice(0, 8);
  }

  /** Toggle current-workspace discovery versus all retained history, including unknown or broken roots. */
  toggleSessionScope(): void {
    if (!this.sessionPicker || this.sessionPicker.loading || this.sessionPicker.resuming) return;
    this.sessionPicker.allWorkspaces = !this.sessionPicker.allWorkspaces;
    this.searchSessions(this.sessionPicker.query, true);
  }

  /** Move the preview through cached results with pages of at most eight rows; a changed selection clears a resume failure. */
  moveSessionPicker(delta: number): void {
    const picker = this.sessionPicker;
    if (!picker || picker.loading || picker.resuming || !picker.total) return;
    const index = Math.max(0, Math.min(picker.total - 1, picker.offset + picker.selectedIndex + delta));
    if (index !== picker.offset + picker.selectedIndex && picker.errorKind === "resume") this.clearPickerError(picker);
    picker.offset = Math.floor(index / 8) * 8;
    picker.selectedIndex = index - picker.offset;
    picker.entries = this.sessionMatches.slice(picker.offset, picker.offset + 8);
  }

  /** Show or hide the visible failure's full text inside the picker; does nothing when no details exist. */
  toggleSessionPickerDetails(): void {
    const picker = this.sessionPicker;
    if (!picker?.errorDetails) return;
    picker.details = !picker.details;
  }

  /** Esc back one level: close open failure details, otherwise close the picker. */
  backSessionPicker(): void {
    if (this.sessionPicker?.details) this.sessionPicker.details = false;
    else this.closeSessionPicker();
  }

  /** Release discovery without reading, repairing or switching any saved conversation. */
  closeSessionPicker(): void { this.sessionResumeAbort?.abort(); this.sessionResumeAbort = undefined; this.sessionPicker = undefined; this.sessionRows = []; this.sessionMatches = []; this.resumePickedSession = undefined; this.loadMoreSessions = undefined; }

  /**
   * Resume only after explicit confirmation, retaining the picker and current runtime on failure. A thrown
   * `SessionResumeError` supplies the short status; any other error reads `Resume failed`. Both keep the full text
   * for F2 details. A resume that returns false without throwing was cancelled and shows no failure, and a failure is
   * dropped when the row, query or scope changed while it ran, because that change clears it.
   */
  async selectPickerSession(): Promise<boolean> {
    const picker = this.sessionPicker;
    const selected = picker?.entries[picker.selectedIndex];
    if (!picker || picker.loading || picker.resuming || !selected || !this.resumePickedSession || this.running) return false;
    if (picker.errorKind === "resume") this.clearPickerError(picker);
    picker.details = false;
    picker.resuming = true;
    // A failure belongs to the row, query and scope it was attempted with; typing during the resume may change them.
    const attempt = { id: selected.id, query: picker.query, allWorkspaces: picker.allWorkspaces };
    const abort = new AbortController();
    this.sessionResumeAbort = abort;
    try {
      const success = await this.resumePickedSession(selected.id, abort.signal);
      if (abort.signal.aborted || this.sessionPicker !== picker) return false;
      if (success) this.closeSessionPicker();
      return success;
    } catch (error) {
      if (abort.signal.aborted || this.sessionPicker !== picker) return false;
      // Changing the row, query or scope clears a resume failure, so a late failure for an earlier one is not shown.
      if (picker.query !== attempt.query || picker.allWorkspaces !== attempt.allWorkspaces || picker.entries[picker.selectedIndex]?.id !== attempt.id) return false;
      const status = error instanceof SessionResumeError ? error.status : SESSION_RESUME_FAILED;
      this.showPickerError(picker, "resume", status, redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
      return false;
    } finally { if (this.sessionPicker === picker) picker.resuming = false; }
  }

  /** Make `status` the visible failure with `details` behind F2, closing any details already open. */
  protected showPickerError(picker: NonNullable<TuiSnapshot["sessionPicker"]>, kind: "discovery" | "more" | "resume", status: string, details: string): void {
    picker.error = status; picker.errorDetails = details; picker.errorKind = kind; picker.details = false;
  }

  /** Drop the visible failure; a retained discovery failure becomes visible again because it still describes the list. */
  protected clearPickerError(picker: NonNullable<TuiSnapshot["sessionPicker"]>): void {
    delete picker.error; delete picker.errorDetails; delete picker.errorKind; delete picker.details;
    this.showDiscoveryError(picker);
  }

  /** Show a retained discovery failure: for the whole list before any batch loaded, otherwise as a load-more failure. */
  protected showDiscoveryError(picker: NonNullable<TuiSnapshot["sessionPicker"]>): void {
    if (!picker.discoveryError) return;
    const more = this.sessionRows.length > 0;
    this.showPickerError(picker, more ? "more" : "discovery", more ? SESSION_LOAD_MORE_FAILED : SESSION_DISCOVERY_FAILED, picker.discoveryError);
  }
}
