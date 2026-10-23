import { createHost, type HostOptions, type HostSessionReference, type Model, type ModelRequest } from "schway/host";

const input = await Bun.stdin.json() as { options: HostOptions; reference?: HostSessionReference; mode: "empty" | "narrow" };
const requests: Array<{ tools: string[]; hostedTools: unknown; toolResults: unknown[] }> = [];
let executions = 0;
const admitted = input.mode === "narrow"
  ? [{ name: "read_note", description: "Read the host fixture note", execution: "parallel" as const, effect: "read-only" as const,
      inputSchema: { type: "object", additionalProperties: false },
      async execute() { executions++; return { content: "fixture-note" }; } }]
  : [];
const host = await createHost({ ...input.options, tools: { policy: "exact", hostedLookup: "off", definitions: admitted } });
const session = input.reference ? await host.openSession(input.reference) : await host.createSession();
const forbidden = ["bash", "write", "edit", "web_fetch", "activate_skill"];
const model: Model = { provider: "scripted", id: "tool-policy-consumer",
  async *stream(request: ModelRequest) {
    requests.push({ tools: request.tools?.map(tool => tool.name) ?? [], hostedTools: request.hostedTools ?? [],
      toolResults: request.items.filter(item => item.type === "tool_result") });
    if (request.hostedTools?.length) throw new Error("Unexpected hosted lookup");
    if (requests.length === 1) {
      const calls = input.mode === "empty"
        ? forbidden.map((name, index) => ({ id: `forbidden-${index}`, name, arguments: name === "activate_skill" ? { name: "repo-skill" } : {} }))
        : [{ id: "admitted", name: "read_note", arguments: {} }, { id: "forbidden-bash", name: "bash", arguments: {} }];
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(),
        content: calls.map(call => ({ type: "tool_call" as const, ...call })) } };
    } else {
      const results = request.items.filter(item => item.type === "tool_result");
      for (const result of results) {
        if (result.type !== "tool_result") continue;
        if (input.mode === "empty" && !result.isError) throw new Error(`Forbidden call executed: ${result.toolCallId}`);
        if (input.mode === "empty" && !result.content.includes("Unknown tool")) throw new Error(`Missing denial: ${result.content}`);
      }
      if (input.mode === "narrow") {
        const admittedResult = results.find(r => r.type === "tool_result" && r.toolCallId === "admitted");
        const deniedResult = results.find(r => r.type === "tool_result" && r.toolCallId === "forbidden-bash");
        if (admittedResult?.type !== "tool_result" || admittedResult.content !== "fixture-note" || admittedResult.isError) throw new Error("Admitted tool did not execute");
        if (deniedResult?.type !== "tool_result" || !deniedResult.isError || !deniedResult.content.includes("Unknown tool")) throw new Error("Narrow denial missing");
      }
      yield { type: "text_delta", text: "provisional" };
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "policy-held" }] } };
    }
  } };
const result = await session.submit({ text: input.reference ? "ทำต่อ" : "enforce exact tools" }, model);
await session.close(); await host.close();
console.log(JSON.stringify({ result, reference: session.reference, requests, executions }));
