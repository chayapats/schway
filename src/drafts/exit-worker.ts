import { basename, dirname, join, resolve } from "node:path";
import { realpathSync, writeFileSync } from "node:fs";
import { isOrdinaryDraft, openDraftStore } from "./store.ts";
import type { ExitDraftCheckpoint } from "./exit.ts";

try {
  const raw = await Bun.stdin.text();
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error("Oversized exit checkpoint");
  const input: ExitDraftCheckpoint = JSON.parse(raw);
  if (typeof input.text !== "string" || !isOrdinaryDraft(input.text) || typeof input.generation !== "string") throw Error("Invalid exit checkpoint");
  const store = openDraftStore(input);
  if (store.generation !== input.generation) throw Error("Checkpoint changed after editor closed");
  if (input.deferredSession) {
    const { path, header } = input.deferredSession;
    const value = header as Record<string, unknown>;
    const directory = join(realpathSync(input.home), ".schway", "sessions");
    if (resolve(dirname(path)) !== directory || realpathSync(dirname(path)) !== directory || basename(path) !== `${input.sessionId}.jsonl` ||
      value.type !== "session" || value.id !== input.sessionId || value.workspaceRoot !== realpathSync(input.workspaceRoot)) throw Error("Invalid deferred session identity");
    writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  }
  store.save(input.text, 1);
  process.stdout.write('{"saved":true,"persisted":true}\n');
} catch { process.exitCode = 1; }
