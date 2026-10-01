import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";

for (const mode of ["interactive", "headless"]) for (const failure of [false, true]) {
  test(`${mode} startup prunes before work and ${failure ? "records failures without blocking" : "retains once-only process scope"}`, async () => {
    await withTempDir(async home => {
      const script = `
        import { mock } from "bun:test";
        import { join } from "node:path";
        import { pathToFileURL } from "node:url";
        import { mkdir, readFile, writeFile } from "node:fs/promises";
        const home = ${JSON.stringify(home)}, source = ${JSON.stringify(join(import.meta.dir, "../src"))};
        const mode = ${JSON.stringify(mode)}, failure = ${failure};
        const load = path => import(pathToFileURL(join(source, path)).href);
        const { openUndoStore } = await load("undo/store.ts");
        const { diagnosticPath } = await load("diagnostics/sink.ts");
        const root = join(home, "work"); await mkdir(root);
        const store = openUndoStore({ home });
        const turn = { sessionId: "old-session", turnId: "old-turn", turnNumber: 1 };
        const manifest = join(home, ".schway", "undo", turn.sessionId, "turns", turn.turnId + ".json");
        const captureExpired = async () => {
          await store.recordShell(turn, { detection: "unavailable" });
          const value = JSON.parse(await readFile(manifest, "utf8")); value.createdAt = "2000-01-01T00:00:00Z";
          await writeFile(manifest, JSON.stringify(value));
        };
        await captureExpired();
        if (failure) await writeFile(manifest, "invalid manifest");
        let requests = 0;
        const assert = (value, message) => { if (!value) throw new Error(message); };
        const model = { provider: "scripted", id: "fixture", async *stream() {
          requests++;
          if (!failure) {
            assert((await store.list("old-session")).length === (requests === 1 ? 0 : 1), "retention must run once before first request");
            if (requests === 1) await captureExpired();
          }
          yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Answer " + requests }] } };
        } };
        const storeCredentials = { get: async () => null, set: async () => {}, delete: async () => {} };
        let stderr = "", code;
        const io = { cwd: root, env: { HOME: home, SCHWAY_MOTION: "off", OPENAI_API_KEY: "fixture-key" }, model,
          credentialStore: storeCredentials, stdout: { write() {} }, stderr: { write(text) { stderr += text; } } };
        if (mode === "headless") {
          const { runCli } = await load("cli/main.ts");
          code = await runCli(["--debug", "--model", "fixture", "-p", "Work"], io);
        } else {
          const { createTestRenderer } = await import("@opentui/core/testing");
          const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
          const fixture = join(source, "tui/credential-input.ts");
          const credentialInput = await import(pathToFileURL(fixture).href);
          const core = await credentialInput.loadCredentialSafeTui();
          mock.module(fixture, () => ({ ...credentialInput, loadCredentialSafeTui: async () => ({ ...core, createCliRenderer: async () => terminal.renderer }) }));
          const { runInteractiveTui } = await load("tui/app.ts");
          const app = runInteractiveTui({ ...io, args: { help: false, json: false, debug: true, model: "fixture" } });
          const wait = async ready => {
            for (let n = 0; n < 500; n++) { await terminal.flush(); if (ready()) return; await Bun.sleep(10); }
            throw new Error("Timed out: " + terminal.captureCharFrame() + stderr);
          };
          try {
            await wait(() => !!terminal.renderer.root.findDescendantById("prompt") && terminal.captureCharFrame().includes("Ready"));
            await terminal.mockInput.pasteBracketedText("Work"); terminal.mockInput.pressEnter();
            await wait(() => terminal.captureCharFrame().includes("Answer 1") && terminal.captureCharFrame().includes("Done"));
            await terminal.mockInput.pasteBracketedText("/new"); terminal.mockInput.pressEnter();
            await wait(() => terminal.captureCharFrame().includes("New session"));
            await terminal.mockInput.pasteBracketedText("More work"); terminal.mockInput.pressEnter();
            await wait(() => terminal.captureCharFrame().includes("Answer 2") && terminal.captureCharFrame().includes("Done"));
            terminal.mockInput.pressKey("d", { ctrl: true }); code = await app;
          } finally { terminal.renderer.destroy(); }
        }
        assert(code === 0, "startup failed: " + stderr);
        const log = (await readFile(diagnosticPath(home), "utf8")).trim().split("\\n").map(line => JSON.parse(line));
        assert(log.filter(entry => entry.component === "undo" && entry.event === "prune_failed").length === (failure ? 1 : 0), "unexpected retention diagnostics");
        assert(requests === (mode === "interactive" ? 2 : 1), "model work did not complete");
        console.log("UNDO_STARTUP_OK");
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, error).toBe(0); expect(output).toContain("UNDO_STARTUP_OK");
    });
  });
}
