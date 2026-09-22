import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "claims.ts");

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(new TextDecoder().decode(p.stderr));
  return new TextDecoder().decode(p.stdout).trim();
}

async function call(repo: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, script, "--repo", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, err, value: out.trim() ? JSON.parse(out) : undefined };
}

async function ok(repo: string, ...args: string[]) {
  const result = await call(repo, ...args);
  if (result.code) throw new Error(result.err);
  return result.value;
}

async function fixture(fn: (f: { repo: string; root: string; base: string; controller: string; claim: (id: number, resource?: string) => Promise<any> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "schway-claims-"));
  const repo = join(root, "repo");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "main");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    const base = git(repo, "rev-parse", "HEAD");
    const controller = (await ok(repo, "acquire", "--key", "coordinator", "--owner", "run-a", "--session", "conversation-a")).token;
    const claim = (id: number, resource = `path:src/feature-${id}`) => ok(repo, "acquire", "--key", `issue-${id}`, "--owner", `worker-${id}`, "--run", "run-a", "--controller-token", controller, "--base", base, "--worktree", join(root, `work-${id}`), "--branch", `agent/issue-${id}`, "--resource", resource);
    await fn({ repo, root, base, controller, claim });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("concurrent coordinators cannot both win and status never exposes tokens", async () => {
  await fixture(async ({ repo, controller }) => {
    await ok(repo, "release", "--key", "coordinator", "--token", controller);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(repo, "acquire", "--key", "coordinator", "--owner", `run-${i}`, "--session", `conversation-${i}`)));
    expect(results.filter(r => r.code === 0)).toHaveLength(1);
    const state = await ok(repo, "status");
    expect(state.claims).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain(results.find(r => r.code === 0)!.value.token);
  });
});

test("duplicate issues and ancestor path reservations reject other workers", async () => {
  await fixture(async ({ repo, claim, base, root, controller }) => {
    await claim(1, "path:src/session");
    await expect(claim(1)).rejects.toThrow("already owned");
    await expect(claim(2, "path:src/session/jsonl.ts")).rejects.toThrow("conflicts");
    const other = await claim(3, "path:src/tools");
    expect(other.key).toBe("issue-3");
    const broad = await call(repo, "acquire", "--key", "issue-4", "--owner", "w4", "--run", "run-a", "--controller-token", controller, "--base", base, "--worktree", join(root, "work-4"), "--branch", "agent/4", "--resource", "path:.");
    expect(broad.code).not.toBe(0);
  });
});

test("linked worktrees share ownership and check rejects wrong cwd or branch", async () => {
  await fixture(async ({ repo, claim }) => {
    const issue = await claim(1);
    git(repo, "worktree", "add", "-b", issue.branch, issue.worktree, issue.base);
    expect((await call(repo, "check", "--key", issue.key, "--token", issue.token)).err).toContain("Wrong worktree");
    expect((await ok(issue.worktree, "check", "--key", issue.key, "--token", issue.token)).valid).toBe(true);
    expect((await ok(issue.worktree, "status")).claims).toHaveLength(2);
    git(issue.worktree, "checkout", "--detach", issue.base);
    expect((await call(issue.worktree, "check", "--key", issue.key, "--token", issue.token)).err).toContain("Wrong branch");
  });
});

test("resource expansion is additive and rejects shared contract collisions", async () => {
  await fixture(async ({ repo, claim }) => {
    const a = await claim(1), b = await claim(2);
    await ok(repo, "update", "--key", a.key, "--token", a.token, "--resource", "contract:session-format");
    const denied = await call(repo, "update", "--key", b.key, "--token", b.token, "--resource", "contract:session-format");
    expect(denied.err).toContain("conflicts");
    const state = await ok(repo, "status");
    expect(state.claims.find((c: any) => c.key === a.key).resources).toEqual(["path:src/feature-1", "contract:session-format"]);
    expect(state.claims.find((c: any) => c.key === b.key).resources).toEqual(["path:src/feature-2"]);
  });
});

test("only the coordinator can finalize and release a stopped issue", async () => {
  await fixture(async ({ repo, controller, claim }) => {
    const issue = await claim(1);
    expect((await call(repo, "release", "--key", issue.key, "--token", "not-owner", "--controller-token", controller)).err).toContain("token mismatch");
    expect((await call(repo, "release", "--key", "coordinator", "--token", controller)).err).toContain("Active issue");
    expect((await call(repo, "update", "--key", issue.key, "--token", issue.token, "--phase", "integrated", "--note", "merged")).err).toContain("Coordinator ownership");
    await ok(repo, "update", "--key", issue.key, "--token", issue.token, "--phase", "abandoned", "--note", "Worker stopped; temporary branch retained", "--controller-token", controller);
    await ok(repo, "release", "--key", issue.key, "--token", issue.token, "--controller-token", controller);
    await ok(repo, "release", "--key", "coordinator", "--token", controller);
    expect((await ok(repo, "status")).claims).toHaveLength(0);
  });
});

test("a ready PR keeps its claim after coordinator handoff", async () => {
  await fixture(async ({ repo, controller, claim }) => {
    const issue = await claim(1);
    await ok(repo, "update", "--key", issue.key, "--token", issue.token, "--phase", "ready", "--note", "Worker stopped; PR awaiting review");
    await ok(repo, "release", "--key", "coordinator", "--token", controller);
    const next = await ok(repo, "acquire", "--key", "coordinator", "--owner", "run-b", "--session", "conversation-b");
    expect(next.owner).toBe("run-b");
    expect((await call(repo, "update", "--key", issue.key, "--token", issue.token, "--phase", "working")).err).toContain("Coordinator ownership");
    expect((await ok(repo, "status")).claims.some((c: any) => c.key === issue.key)).toBe(true);
  });
});

test("orphan mutex and corrupt records fail closed without deleting evidence", async () => {
  await fixture(async ({ repo }) => {
    const root = join(repo, ".git", "schway-agent-claims");
    await mkdir(join(root, ".mutation-lock"));
    expect((await call(repo, "status")).err).toContain("Registry mutation in progress");
    await rm(join(root, ".mutation-lock"), { recursive: true });
    await writeFile(join(root, "issue-99.json"), "broken-record");
    expect((await call(repo, "status")).code).not.toBe(0);
    expect(await readFile(join(root, "issue-99.json"), "utf8")).toBe("broken-record");
  });
});

test("invalid ownership paths and resources never reserve work", async () => {
  await fixture(async ({ repo, base, controller }) => {
    const args = ["acquire", "--key", "issue-1", "--owner", "w", "--run", "run-a", "--controller-token", controller, "--base", base, "--branch", "agent/1"];
    expect((await call(repo, ...args, "--worktree", repo, "--resource", "path:src")).err).toContain("separate worktree");
    expect((await call(repo, ...args, "--worktree", join(repo, "nested"), "--resource", "path:src")).err).toContain("separate worktree");
    expect((await call(repo, ...args, "--worktree", `${repo}-work`, "--resource", "path:../other")).code).not.toBe(0);
    expect((await ok(repo, "status")).claims).toHaveLength(1);
  });
});

test("symlink and case aliases conflict, and external symlinks are rejected", async () => {
  await fixture(async ({ repo, root, claim }) => {
    await mkdir(join(repo, "src", "cli"), { recursive: true });
    await writeFile(join(repo, "src", "cli", "main.ts"), "fixture\n");
    await symlink("cli", join(repo, "src", "alias"));
    await symlink(root, join(repo, "outside"));
    await claim(1, "path:src/cli/main.ts");
    await expect(claim(2, "path:src/alias/main.ts")).rejects.toThrow("conflicts");
    await expect(claim(3, "path:SRC/CLI/MAIN.TS")).rejects.toThrow("conflicts");
    await expect(claim(4, "path:outside/file.ts")).rejects.toThrow("escapes worktree");
  });
});

test("concurrent resumers have one winner, and old worker tokens stay fenced until adoption", async () => {
  await fixture(async ({ repo, controller, claim }) => {
    const issue = await claim(1);
    git(repo, "worktree", "add", "-b", issue.branch, issue.worktree, issue.base);
    await ok(repo, "update", "--key", issue.key, "--token", issue.token, "--phase", "blocked", "--note", "Old worker stopped and acknowledged handoff");
    const results = await Promise.all(["resume-a", "resume-b"].map(session => call(repo, "resume", "--key", "coordinator", "--token", controller, "--session", session, "--note", "Old coordinator stopped; all subprocesses settled")));
    expect(results.filter(r => r.code === 0)).toHaveLength(1);
    const renewed = results.find(r => r.code === 0)!.value;
    expect(renewed.token).not.toBe(controller);
    expect((await call(repo, "check", "--key", "coordinator", "--token", controller)).code).not.toBe(0);
    expect((await call(issue.worktree, "check", "--key", issue.key, "--token", issue.token)).err).toContain("Coordinator ownership");
    const adopted = await ok(repo, "adopt", "--key", issue.key, "--token", issue.token, "--controller-token", renewed.token, "--owner", "replacement-worker", "--note", "Stopped worker; dirty artifacts preserved");
    expect(adopted.token).not.toBe(issue.token);
    expect((await call(issue.worktree, "check", "--key", issue.key, "--token", issue.token)).err).toContain("token mismatch");
    expect((await ok(issue.worktree, "check", "--key", issue.key, "--token", adopted.token)).valid).toBe(true);
  });
});

test("dangling symlink files and parents cannot evade reservations or escape the workspace", async () => {
  await fixture(async ({ repo, root, claim }) => {
    await mkdir(join(repo, "src", "cli"), { recursive: true });
    await symlink("cli/future.ts", join(repo, "src", "alias.ts"));
    await symlink(join(root, "outside-new.ts"), join(repo, "src", "outside.ts"));
    await symlink("missing-directory", join(repo, "src", "parent-alias"));
    await claim(1, "path:src/cli/future.ts");
    await expect(claim(2, "path:src/alias.ts")).rejects.toThrow("Dangling symlink");
    await expect(claim(3, "path:src/outside.ts")).rejects.toThrow("Dangling symlink");
    await expect(claim(4, "path:src/parent-alias/new.ts")).rejects.toThrow("Dangling symlink");
    expect((await ok(repo, "status")).claims).toHaveLength(2);
  });
});
