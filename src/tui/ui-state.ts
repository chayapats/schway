import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Read the interactive splash version, treating unavailable or malformed state as unseen. */
export async function readSplashSeenVersion(home: string): Promise<string | undefined> {
  try {
    const state: unknown = JSON.parse(await readFile(join(home, ".schway", "ui-state.json"), "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
    const value = (state as Record<string, unknown>).splashSeenVersion;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch { return undefined; }
}

/** Atomically remember a painted full splash; storage failures are deliberately silent and best-effort. */
export async function recordSplashSeenVersion(home: string, version: string): Promise<void> {
  const directory = join(home, ".schway");
  const temporary = join(directory, `.ui-state-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify({ splashSeenVersion: version }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, "ui-state.json"));
  } catch { /* Decorative state must never interrupt startup or add a transcript notice. */ }
  finally { await unlink(temporary).catch(() => {}); }
}
