import { Database } from "bun:sqlite";
import { mkdirSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";

/** User-wide opaque route identities ordered by pin time and successful use. */
export interface ModelPreferencesSnapshot {
  favorites: string[];
  recents: string[];
  models?: Record<string, { modelId: string; groupIdentity: string }>;
}

/** Persist hashed route identities and bounded model IDs, never endpoints or credentials, while merging concurrent writers. */
export class ModelPreferences {
  private readonly path: string;

  /** Bind preference operations to this user home without opening storage. */
  constructor(home: string) {
    this.path = join(home, ".schway", "model-preferences.sqlite");
  }

  /** Read validated favorites and recent choices without retaining a database handle. */
  read(): ModelPreferencesSnapshot {
    return this.transaction();
  }

  /** Set an explicit pin state without overwriting another process's unrelated pins. */
  pin(identity: string, pinned: boolean, model?: { modelId: string; groupIdentity: string }): ModelPreferencesSnapshot {
    return this.transaction({ identity, pinned, model });
  }

  /** Move a successfully activated exact route identity to the front of recent choices. */
  used(identity: string, model?: { modelId: string; groupIdentity: string }): ModelPreferencesSnapshot {
    return this.transaction({ identity, model });
  }

  /** Validate stored rows and atomically merge one bounded preference operation. */
  private transaction(change?: { identity: string; pinned?: boolean; model?: { modelId: string; groupIdentity: string } }): ModelPreferencesSnapshot {
    if (change && !validIdentity(change.identity)) throw new Error("Invalid model identity");
    if (change?.model && (!validIdentity(change.model.groupIdentity) || !validModelId(change.model.modelId))) throw new Error("Invalid model identity");
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(this.path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const db = new Database(this.path);
    try {
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS preferences (identity TEXT PRIMARY KEY, pinned INTEGER, recent INTEGER, model TEXT, route TEXT)");
      const rows = db.query("SELECT identity, pinned, recent, model, route FROM preferences").all() as { identity: string; pinned: number | null; recent: number | null; model: string | null; route: string | null }[];
      if (rows.length > 160 || rows.some(row => !validIdentity(row.identity) || !validOrder(row.pinned) || !validOrder(row.recent) || (row.model !== null || row.route !== null) && (!validModelId(row.model) || !validIdentity(row.route)))) throw new Error("Invalid model preferences");
      if (change) {
        const order = Math.max(0, ...rows.flatMap(row => [row.pinned ?? 0, row.recent ?? 0])) + 1;
        if (!Number.isSafeInteger(order)) throw new Error("Invalid model preferences");
        if (change.pinned === undefined) db.query("INSERT INTO preferences(identity, recent) VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET recent = excluded.recent").run(change.identity, order);
        else db.query("INSERT INTO preferences(identity, pinned) VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET pinned = excluded.pinned").run(change.identity, change.pinned ? order : null);
        if (change.model) db.query("UPDATE preferences SET model = ?, route = ? WHERE identity = ?").run(change.model.modelId, change.model.groupIdentity, change.identity);
        db.exec("UPDATE preferences SET recent = NULL WHERE identity NOT IN (SELECT identity FROM preferences WHERE recent IS NOT NULL ORDER BY recent DESC LIMIT 32)");
        if ((db.query("SELECT COUNT(*) AS count FROM preferences WHERE pinned IS NOT NULL").get() as { count: number }).count > 128) throw new Error("Favorite limit reached · Unpin a model first");
        db.exec("DELETE FROM preferences WHERE pinned IS NULL AND recent IS NULL");
      }
      const favorites = (db.query("SELECT identity FROM preferences WHERE pinned IS NOT NULL ORDER BY pinned DESC, identity").all() as { identity: string }[]).map(row => row.identity);
      const recents = (db.query("SELECT identity FROM preferences WHERE recent IS NOT NULL ORDER BY recent DESC, identity").all() as { identity: string }[]).map(row => row.identity);
      const models = Object.fromEntries((db.query("SELECT identity, model, route FROM preferences WHERE model IS NOT NULL").all() as { identity: string; model: string; route: string }[]).map(row => [row.identity, { modelId: row.model, groupIdentity: row.route }]));
      db.exec("COMMIT");
      return { favorites, recents, models };
    } finally { db.close(); }
  }
}

/** Accept only opaque exact-route digests, never endpoints or credentials. */
function validIdentity(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
/** Reject malformed sequence values before sorting or updating preferences. */
function validOrder(value: unknown): boolean { return value === null || typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** Accept bounded model IDs while excluding URLs and terminal control characters. */
function validModelId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]|:\/\//.test(value); }
