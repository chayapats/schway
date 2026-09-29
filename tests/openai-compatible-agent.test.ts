import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ToolResult, UserMessage } from "../src/conversation/types.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { createSession } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import {
  encodeChatCompletionsSse,
  TEXT_STREAM_CHUNKS,
  TOOL_USE_STREAM_CHUNKS,
} from "./fixtures/openai-compatible.ts";
import { withTempDir } from "./helpers.ts";
import { collect } from "./helpers/scripted-model.ts";

type RecordedRequest = {
  url: string;
  authorization: string | null;
  header: string | null;
  body: {
    temperature?: number;
    messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>;
  };
};

/** Local Chat Completions stand-in used by real-loop tests. */
async function withLocalServer(
  handler: (index: number, request: Request) => Promise<Response> | Response,
  fn: (input: { baseUrl: string; recorded: RecordedRequest[] }) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = [];
  let index = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      index += 1;
      recorded.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        header: request.headers.get("x-test-header"),
        body: (await request.json()) as RecordedRequest["body"],
      });
      return handler(index, request);
    },
  });
  try {
    await fn({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      recorded,
    });
  } finally {
    server.stop(true);
  }
}

function sseResponse(chunks: readonly object[]): Response {
  return new Response(encodeChatCompletionsSse(chunks), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("real-loop headless conversation completes a read-tool round trip against a local server", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello from workspace\n");
    await withLocalServer(
      async (index) =>
        sseResponse(index === 1 ? TOOL_USE_STREAM_CHUNKS : TEXT_STREAM_CHUNKS),
      async ({ baseUrl, recorded }) => {
        const model = createOpenAICompatibleModel({
          baseUrl,
          auth: "none",
        });
        const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
        const session = createSession([
          {
            type: "user",
            id: "u1",
            content: [{ type: "text", text: "read note.txt" }],
          } satisfies UserMessage,
        ]);
        const events = await collect(
          runAgentLoop({
            session,
            model,
            contextManager: createContextManager(workspace),
            tools: createToolRegistry([readTool]),
            workspace,
          }),
        );

        expect(events.some((event) => event.type === "tool.started")).toBe(true);
        expect(events.some((event) => event.type === "tool.finished")).toBe(true);
        expect(events.at(-1)).toEqual({
          type: "agent.finished",
          reason: "completed",
        });
        expect(recorded).toHaveLength(2);
        expect(recorded[0]?.url).toBe(`${baseUrl}/chat/completions`);
        const toolOutput = recorded[1]?.body.messages?.find(
          (item) => item.role === "tool",
        );
        expect(toolOutput?.tool_call_id).toBe("call_read1");
        expect(String(toolOutput?.content)).toContain("hello from workspace");
        const result = session.items.find(
          (item): item is ToolResult => item.type === "tool_result",
        );
        expect(result?.toolCallId).toBe("call_read1");
        expect(result?.content).toContain("hello from workspace");
      },
    );
  });
});

test("each auth mode is honored by a real-loop local conversation", async () => {
  const scenarios = [
    { auth: "none" as const, apiKey: "sk-compat", authorization: null },
    { auth: "optional" as const, apiKey: undefined, authorization: null },
    {
      auth: "optional" as const,
      apiKey: "sk-compat",
      authorization: "Bearer sk-compat",
    },
    {
      auth: "required" as const,
      apiKey: "sk-compat",
      authorization: "Bearer sk-compat",
    },
  ];
  for (const scenario of scenarios) {
    await withLocalServer(async () => sseResponse(TEXT_STREAM_CHUNKS), async ({
      baseUrl,
      recorded,
    }) => {
      const model = createOpenAICompatibleModel({
        baseUrl,
        auth: scenario.auth,
        apiKey: scenario.apiKey,
      });
      const workspace = {
        root: process.cwd(),
        launchCwd: process.cwd(),
        extraRoots: [],
      };
      const events = await collect(
        runAgentLoop({
          session: createSession([
            {
              type: "user",
              id: "u1",
              content: [{ type: "text", text: "hello" }],
            },
          ]),
          model,
          contextManager: createContextManager(workspace),
        }),
      );
      expect(events.at(-1)).toEqual({
        type: "agent.finished",
        reason: "completed",
      });
      expect(recorded[0]?.authorization).toBe(scenario.authorization);
    });
  }
});

test("custom request options reach the local compatible endpoint", async () => {
  await withLocalServer(async () => sseResponse(TEXT_STREAM_CHUNKS), async ({
    baseUrl,
    recorded,
  }) => {
    const model = createOpenAICompatibleModel({
      baseUrl,
      auth: "none",
      headers: { "X-Test-Header": "ok" },
      extraBody: { temperature: 0.2 },
    });
    const workspace = {
      root: process.cwd(),
      launchCwd: process.cwd(),
      extraRoots: [],
    };
    await collect(
      runAgentLoop({
        session: createSession([
          {
            type: "user",
            id: "u1",
            content: [{ type: "text", text: "hello" }],
          },
        ]),
        model,
        contextManager: createContextManager(workspace),
      }),
    );
    expect(recorded[0]?.header).toBe("ok");
    expect(recorded[0]?.body.temperature).toBe(0.2);
  });
});

test("local-server split SSE frames still complete a headless conversation", async () => {
  await withLocalServer(
    async () => {
      const bytes = new TextEncoder().encode(
        encodeChatCompletionsSse(TEXT_STREAM_CHUNKS),
      );
      let offset = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 9, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    async ({ baseUrl }) => {
      await withTempDir(async (home) => {
        const stdout = { text: "", write(chunk: string) { this.text += chunk; } };
        const stderr = { text: "", write(chunk: string) { this.text += chunk; } };
        const exitCode = await runCli(
          [
            "-p",
            "hello",
            "--provider",
            "openai-compatible",
            "--base-url",
            baseUrl,
            "--auth",
            "none",
            "--model",
            "gpt-4o",
          ],
          {
            stdout,
            stderr,
            env: { HOME: home, OPENAI_API_KEY: "sk-should-not-use" },
            cwd: process.cwd(),
          },
        );
        expect(exitCode).toBe(0);
        expect(stdout.text).toContain("Hello world");
        expect(stderr.text).toBe("");
      });
    },
  );
});

test("local-server endpoint errors surface without credentials or retries", async () => {
  let fetches = 0;
  await withLocalServer(
    async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({
          error: { message: "Incorrect API key provided: sk-secret" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    },
    async ({ baseUrl }) => {
      const model = createOpenAICompatibleModel({
        baseUrl,
        auth: "required",
        apiKey: "sk-secret",
      });
      const workspace = {
        root: process.cwd(),
        launchCwd: process.cwd(),
        extraRoots: [],
      };
      const events = await collect(
        runAgentLoop({
          session: createSession([
            {
              type: "user",
              id: "u1",
              content: [{ type: "text", text: "hello" }],
            },
          ]),
          model,
          contextManager: createContextManager(workspace),
        }),
      );
      const error = events.find((event) => event.type === "error");
      expect(error?.type).toBe("error");
      if (error?.type === "error") {
        expect(error.message).toMatch(/authentication failed/i);
        expect(error.message.includes("sk-secret")).toBe(false);
      }
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
      expect(fetches).toBe(1);
    },
  );
});

test("cancelling a local-server stream ends the loop without another attempt", async () => {
  const controller = new AbortController();
  let fetches = 0;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await withLocalServer(
    async () => {
      fetches += 1;
      requestStarted();
      return new Response(
        new ReadableStream({
          start() {
            // Keep the SSE body open until abort cancels it.
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    },
    async ({ baseUrl }) => {
      const model = createOpenAICompatibleModel({
        baseUrl,
        auth: "none",
      });
      const workspace = {
        root: process.cwd(),
        launchCwd: process.cwd(),
        extraRoots: [],
      };
      const pending = collect(
        runAgentLoop({
          session: createSession([
            {
              type: "user",
              id: "u1",
              content: [{ type: "text", text: "hello" }],
            },
          ]),
          model,
          contextManager: createContextManager(workspace),
          signal: controller.signal,
        }),
      );
      await started;
      controller.abort();
      const events = await pending;
      expect(events.at(-1)).toEqual({
        type: "agent.finished",
        reason: "cancelled",
      });
      expect(fetches).toBe(1);
    },
  );
});
