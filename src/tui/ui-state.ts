import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Read the interactive version within 100 ms, treating failed, cancelled or malformed state as unseen. */
export async function readSplashSeenVersion(home: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<undefined>(resolve => { stop = () => { resolve(undefined); abort.abort(); }; });
  signal?.addEventListener("abort", stop, { once: true });
  timer = setTimeout(stop, 100);
  try {
    const text = await Promise.race([readFile(join(home, ".schway", "ui-state.json"), { encoding: "utf8", signal: abort.signal }), stopped]);
    if (text === undefined) return undefined;
    const state: unknown = JSON.parse(text);
    if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
    const value = (state as Record<string, unknown>).splashSeenVersion;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch { return undefined; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
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
