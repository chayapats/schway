import { join } from "node:path";

/** Frozen ordinary input and its expected checkpoint generation, consumed only after the UI stops editing. */
export interface ExitDraftCheckpoint {
  home: string;
  workspaceRoot: string;
  sessionId: string;
  text: string;
  generation: string;
  deferredSession?: { path: string; header: unknown };
}

/** Result distinguishes confirmed checkpoints from timeout or failed writes without exposing input. */
export interface ExitDraftResult { saved: boolean; failed: boolean; persisted?: boolean; timedOut?: boolean }

/** Flush in an isolated process for at most 500 ms, killing slow writes without delaying terminal cleanup. */
export async function flushDraftOnExit(input: ExitDraftCheckpoint, workerPath = join(import.meta.dir, "exit-worker.ts")): Promise<ExitDraftResult> {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined;
  let cancelRead: (() => Promise<void>) | undefined;
  const stopWorker = () => {
    try { child?.kill("SIGKILL"); } catch { /* Exit can race a completed worker. */ }
    try { child?.unref(); } catch { /* Terminal cleanup must still proceed. */ }
    try { void cancelRead?.().catch(() => {}); } catch { /* Reader may already be released. */ }
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, workerPath], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env });
    const worker = child;
    const result = (async (): Promise<ExitDraftResult> => {
      worker.stdin.write(JSON.stringify(input)); worker.stdin.end();
      const outputReader = worker.stdout.getReader();
      cancelRead = () => outputReader.cancel();
      let output = "";
      try {
        while (true) {
          const chunk = await outputReader.read(); if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
          if (output.length > 1024) throw Error("Unexpected checkpoint worker response");
        }
      } finally { cancelRead = undefined; outputReader.releaseLock(); }
      const code = await worker.exited;
      return code === 0 && output.trim() === '{"saved":true,"persisted":true}' ? { saved: !!input.text, failed: false, persisted: true } : { saved: false, failed: true };
    })().catch(() => ({ saved: false, failed: true }));
    return await Promise.race([result, new Promise<ExitDraftResult>(resolve => {
      deadline = setTimeout(() => { stopWorker(); resolve({ saved: false, failed: true, timedOut: true }); }, 500);
    })]);
  } catch { return { saved: false, failed: true }; }
  finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null) stopWorker();
  }
}
