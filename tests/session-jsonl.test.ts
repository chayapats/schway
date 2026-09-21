import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "../src/conversation/types.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { withTempDir } from "./helpers.ts";

const workspace = {
  root: "/tmp/project",
  launchCwd: "/tmp/project/src",
  extraRoots: ["/tmp/extra"],
};

test("creating a session writes a versioned JSONL header with workspace identity", async () => {
  await withTempDir(async (dir) => {
    const session = await createJsonlSession({ directory: dir, workspace });
    const text = await Bun.file(join(dir, `${session.header.id}.jsonl`)).text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "session",
      version: 1,
      id: session.header.id,
      createdAt: session.header.createdAt,
      workspaceRoot: "/tmp/project",
      launchCwd: "/tmp/project/src",
      extraRoots: ["/tmp/extra"],
    });
    expect(session.header.id.length).toBeGreaterThan(0);
    expect(session.header.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

test("appended messages reload with parent identifiers and provider metadata", async () => {
  await withTempDir(async (dir) => {
    const created = await createJsonlSession({ directory: dir, workspace });
    const user: UserMessage = {
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "hi" }],
    };
    const assistant: AssistantMessage = {
      type: "assistant",
      id: "a1",
      content: [
        { type: "thinking", text: "hmm", providerMetadata: { thought: "sig" } },
        { type: "text", text: "hello" },
      ],
      providerMetadata: { opaque: "keep-me" },
    };
    created.append(user, assistant);

    const loaded = await loadJsonlSession({
      directory: dir,
      id: created.header.id,
    });
    expect(loaded.header).toEqual(created.header);
    expect(loaded.items).toEqual([user, assistant]);

    const records = (await Bun.file(join(dir, `${created.header.id}.jsonl`)).text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; parentId?: string; type: string });
    expect(records[1]).toMatchObject({
      type: "user",
      id: "u1",
      parentId: created.header.id,
    });
    expect(records[2]).toMatchObject({
      type: "assistant",
      id: "a1",
      parentId: "u1",
    });
  });
});

test("unsupported session versions fail with an actionable error", async () => {
  await withTempDir(async (dir) => {
    const header = {
      type: "session",
      version: 99,
      id: "sess-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "/tmp/project",
      launchCwd: "/tmp/project",
      extraRoots: [],
    };
    await writeFile(join(dir, "sess-old.jsonl"), `${JSON.stringify(header)}\n`);
    await expect(
      loadJsonlSession({ directory: dir, id: "sess-old" }),
    ).rejects.toThrow(/Unsupported session format version 99/);
    await expect(
      loadJsonlSession({ directory: dir, id: "sess-old" }),
    ).rejects.toThrow(/version 1/);
  });
});

test("a partial trailing record is skipped without destroying valid history", async () => {
  await withTempDir(async (dir) => {
    const created = await createJsonlSession({ directory: dir, workspace });
    const user: UserMessage = {
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "keep me" }],
    };
    created.append(user);
    const path = join(dir, `${created.header.id}.jsonl`);
    const valid = await Bun.file(path).text();
    await writeFile(
      path,
      `${valid}{"type":"assistant","id":"a1","parentId":"u1"`,
    );

    const loaded = await loadJsonlSession({
      directory: dir,
      id: created.header.id,
    });
    expect(loaded.items).toEqual([user]);
    expect(await Bun.file(path).text()).toBe(
      `${valid}{"type":"assistant","id":"a1","parentId":"u1"`,
    );
  });
});

test("loading an interrupted session settles unresolved tool calls without rerunning them", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    const sessions = join(dir, "sessions");
    const created = await createJsonlSession({
      directory: sessions,
      workspace: { root: project, launchCwd: project, extraRoots: [] },
    });
    created.append({
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "write it" }],
    });
    created.append({
      type: "assistant",
      id: "a1",
      content: [
        {
          type: "tool_call",
          id: "call-write",
          name: "write",
          arguments: { path: "secret.txt", content: "nope" },
        },
      ],
    });

    const loaded = await loadJsonlSession({
      directory: sessions,
      id: created.header.id,
    });
    const result = loaded.items.find((item) => item.type === "tool_result");
    if (result?.type !== "tool_result") {
      throw new Error("expected a settlement tool result");
    }
    expect(result.toolCallId).toBe("call-write");
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("interrupted");
    expect(loaded.items).toHaveLength(3);
    expect(await Bun.file(join(project, "secret.txt")).exists()).toBe(false);

    const reloaded = await loadJsonlSession({
      directory: sessions,
      id: created.header.id,
    });
    const results = reloaded.items.filter((item) => item.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(result.id);
  });
});

test("a malformed trailing record is skipped without destroying valid history", async () => {
  await withTempDir(async (dir) => {
    const created = await createJsonlSession({ directory: dir, workspace });
    const user: UserMessage = {
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "keep me" }],
    };
    created.append(user);
    const path = join(dir, `${created.header.id}.jsonl`);
    const valid = await Bun.file(path).text();
    const trailing = '{"type":"not-a-message","id":"x","parentId":"u1"}\n';
    await writeFile(path, `${valid}${trailing}`);

    const loaded = await loadJsonlSession({
      directory: dir,
      id: created.header.id,
    });
    expect(loaded.items).toEqual([user]);
    expect(await Bun.file(path).text()).toBe(`${valid}${trailing}`);
  });
});

test("session ids cannot escape the sessions directory", async () => {
  await withTempDir(async (dir) => {
    await expect(
      loadJsonlSession({ directory: dir, id: "../escape" }),
    ).rejects.toThrow(/Invalid session id/);
  });
});
