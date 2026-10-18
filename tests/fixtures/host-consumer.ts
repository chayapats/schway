import { createHost, hostCapabilities, type HostOptions, type HostSessionReference, type HostEntryReference, type Model, type ToolDefinition } from "schway/host";

const input = await Bun.stdin.json() as { options: HostOptions; reference?: HostSessionReference; previous?: HostEntryReference; discovery?: boolean };
if (input.discovery) {
  console.log(JSON.stringify(hostCapabilities()));
} else {
  let calls = 0, executions = 0;
  const readNote: ToolDefinition = { name: "read_note", description: "Read the host fixture note", execution: "parallel", effect: "read-only",
    inputSchema: { type: "object", additionalProperties: false },
    async execute() { executions++; return { content: "fixture-note" }; } };
  const host = await createHost({ ...input.options, tools: { policy: "include-skill-activation", definitions: [readNote] } });
  const session = input.reference ? await host.openSession(input.reference) : await host.createSession();
  const previous = input.previous ? session.readResult(input.previous) : undefined;
  const model: Model = {
    provider: "scripted", id: "host-consumer",
    async *stream(request) {
      calls++;
      if (request.systemPrompt !== "Trusted fixture operator") throw new Error("Lost trusted host prompt");
      if (!request.context.some(s => s.name === "host-evidence" && s.content === "fixture-source")) throw new Error("Lost supplied host context");
      if (request.hostedTools?.length) throw new Error("Unexpected hosted lookup");
      if (!request.items.some(item => item.type === "user" && item.content[0]?.text === "โครงการแรก")) throw new Error("Lost native ancestry");
      if (!input.reference && calls === 1) {
        yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "tool_call", id: "read-fixture", name: "read_note", arguments: {} }] } };
      } else {
        if (!input.reference && !request.items.some(item => item.type === "tool_result" && item.content === "fixture-note")) throw new Error("Lost native tool result");
        yield { type: "text_delta", text: "provisional" };
        yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: input.reference ? "continued" : "persisted" }] } };
      }
    },
  };
  const result = await session.submit({ text: input.reference ? "ทำต่อ" : "โครงการแรก" }, model);
  await session.close(); await host.close();
  console.log(JSON.stringify({ result, reference: session.reference, previous, calls, executions }));
}
