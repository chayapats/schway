import { createHost, type HostOptions, type HostSessionReference, type HostEntryReference, type Model } from "schway/host";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as nativeFs from "node:fs";
import { mock } from "bun:test";

const input = await Bun.stdin.json() as { options: HostOptions; reference: HostSessionReference; previous?: HostEntryReference;
  action: "hold" | "crash-tool" | "continue" | "fault-input" | "fault-provider" | "fault-tool"; effectPath?: string };
let calls = 0, executions = 0;
if (input.action.startsWith("fault-")) {
  const actual = { ...nativeFs };
  const target = input.action === "fault-input" ? "user" : input.action === "fault-provider" ? "assistant" : "tool_result";
  mock.module("node:fs", () => ({ ...actual, writeSync(fd: number, bytes: Buffer, offset: number, length: number) {
    const operation = JSON.parse(bytes.toString());
    if (operation.entries?.some((entry: { item: { type: string } }) => entry.item.type === target)) {
      actual.writeSync(fd, bytes, offset, Math.floor(length / 2));
      throw Object.assign(new Error("Injected partial native append"), { code: "EIO" });
    }
    return actual.writeSync(fd, bytes, offset, length);
  } }));
}
try {
  const host = await createHost({ ...input.options, tools: { policy: "exact", hostedLookup: "off", definitions: [{
    name: "effect", description: "Record one non-idempotent fixture effect", execution: "exclusive", effect: "mutating", inputSchema: { type: "object" },
    async execute() {
      executions++;
      await appendFile(input.effectPath!, "effect\n");
      if (input.action === "fault-tool") return { content: "effect happened" };
      console.log(JSON.stringify({ state: "effect", reference: session.reference }));
      await new Promise(() => { setInterval(() => {}, 1000); });
      return { content: "unreachable" };
    },
  }] } });
  const session = await host.openSession(input.reference);
  const previous = input.previous ? session.readResult(input.previous) : undefined;
  let ancestry: unknown;
  const model: Model = { provider: "scripted", id: "durable-consumer", async *stream(request) {
    calls++;
    ancestry = request.items;
    const saved = await readFile(join(input.options.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    if (!saved.includes("external accepted input")) throw new Error("Input was not persisted before inference");
    if (input.action === "hold") {
      console.log(JSON.stringify({ state: "accepted", reference: session.reference }));
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(),
      providerMetadata: { opaque: "provider-response" }, content: (input.action === "crash-tool" || input.action === "fault-tool")
        ? [{ type: "tool_call", id: "effect-call", name: "effect", arguments: {}, providerMetadata: { opaque: "call-replay" } }]
        : [{ type: "text", text: "continued" }] } };
  } };
  let run;
  try { run = await session.submit({ text: "external accepted input" }, model); }
  finally { await host.close(); }
  console.log(JSON.stringify({ state: "finished", run, previous, ancestry, calls, executions, reference: session.reference }));
} catch (error) {
  console.log(JSON.stringify({ state: "rejected", code: (error as { code?: string }).code, calls, executions }));
}
