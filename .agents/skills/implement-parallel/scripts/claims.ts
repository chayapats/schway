import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Claim = {
  key: string; owner: string; token: string; session: string; run?: string;
  createdAt: string; updatedAt: string; phase: string; note?: string;
  base?: string; branch?: string; worktree?: string; resources: string[];
};

const phases = new Set(["reserved", "working", "review", "ready", "blocked", "integrated", "abandoned"]);

function parse(argv: string[]): { command: string; flags: Map<string, string[]> } {
  const flags = new Map<string, string[]>();
  let command = "";
  const allowed = new Set(["repo", "key", "owner", "session", "run", "token", "controller-token", "base", "branch", "worktree", "resource", "phase", "note"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      if (command) throw new Error("Exactly one command is required");
      command = arg;
      continue;
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (!allowed.has(key) || !value || value.startsWith("--")) throw new Error(`Invalid option: ${arg}`);
    if (key !== "resource" && flags.has(key)) throw new Error(`Duplicate option: ${arg}`);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  if (!["status", "acquire", "check", "update", "release", "resume", "adopt"].includes(command)) throw new Error("Command: status | acquire | check | update | release | resume | adopt");
  return { command, flags };
}

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || "Git failed");
  return new TextDecoder().decode(result.stdout).trim();
}

async function canonicalPath(path: string): Promise<string> {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try { existing = await realpath(existing); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await lstat(existing)).isSymbolicLink()) throw new Error(`Dangling symlink cannot be reserved: ${existing}`);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") throw probeError;
      }
      suffix.unshift(basename(existing));
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return resolve(existing, ...suffix);
}

async function resource(value: string, workspace: string): Promise<string> {
  if (/^contract:[a-z0-9][a-z0-9._-]*$/.test(value)) return value;
  if (!value.startsWith("path:")) throw new Error(`Invalid resource: ${value}`);
  const path = value.slice(5).replace(/\/$/, "");
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => p === ".." || p === "")) throw new Error(`Invalid relative resource: ${value}`);
  if (path !== "." && path.split("/").includes(".")) throw new Error(`Use normalized resource: ${value}`);
  const canonical = await canonicalPath(resolve(workspace, path));
  const local = relative(workspace, canonical);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Resource escapes worktree: ${value}`);
  // Conservative case folding also protects not-yet-created files on macOS.
  return `path:${local ? local.split(sep).join("/").toLowerCase() : "."}`;
}

function overlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("path:") || !b.startsWith("path:")) return false;
  const x = a.slice(5), y = b.slice(5);
  return x === "." || y === "." || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

async function main(): Promise<void> {
  const { command, flags } = parse(process.argv.slice(2));
  const get = (key: string, required = false): string | undefined => {
    const value = flags.get(key)?.[0];
    if (required && !value) throw new Error(`Missing --${key}`);
    return value;
  };
  const repo = await realpath(get("repo", true)!);
  const common = await realpath(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
  const workspace = await realpath(git(repo, "rev-parse", "--show-toplevel"));
  const root = join(common, "schway-agent-claims");
  const key = get("key");
  if (command !== "status" && (!key || !/^(coordinator|issue-[1-9][0-9]*)$/.test(key))) throw new Error("Key must be coordinator or issue-<positive-number>");
  await mkdir(root, { recursive: true });
  const mutex = join(root, ".mutation-lock");
  try { await mkdir(mutex); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Registry mutation in progress; retry after its owner completes. Never remove a lock based on age alone.");
    throw error;
  }
  try {
    await writeFile(join(mutex, "owner.json"), JSON.stringify({ pid: process.pid, command, at: new Date().toISOString() }));
    const claims: Claim[] = [];
    for (const file of await readdir(root)) {
      if (!file.endsWith(".json")) continue;
      const c = JSON.parse(await readFile(join(root, file), "utf8")) as Claim;
      if (file !== `${c.key}.json` || !c.token || !c.owner || !c.session || !Array.isArray(c.resources) || !phases.has(c.phase)) throw new Error(`Corrupt claim: ${file}; preserve it and recover ownership explicitly`);
      claims.push(c);
    }
    const controller = claims.find(c => c.key === "coordinator");
    const current = claims.find(c => c.key === key);
    const publicClaim = ({ token: _token, ...rest }: Claim) => rest;
    const requireController = (run: string | undefined, requireToken: boolean, session?: string) => {
      if (!controller || controller.owner !== run || (session !== undefined && controller.session !== session) || (requireToken && controller.token !== get("controller-token"))) throw new Error("Coordinator ownership mismatch");
    };
    const owned = () => {
      if (!current || current.token !== get("token", true)) throw new Error("Claim token mismatch or claim missing");
      return current;
    };
    const ensureResources = (resources: string[], except?: string) => {
      for (const other of claims) {
        if (other.key === except || other.key === "coordinator") continue;
        for (const a of resources) for (const b of other.resources) {
          if (overlap(a, b)) throw new Error(`Resource ${a} conflicts with ${other.key} owned by ${other.owner} (${b})`);
        }
      }
    };
    const persist = async (claim: Claim) => {
      const tmp = join(root, `${claim.key}.tmp`);
      await writeFile(tmp, JSON.stringify(claim, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, join(root, `${claim.key}.json`));
    };
    if (command === "status") {
      console.log(JSON.stringify({ common, claims: claims.map(publicClaim) }));
      return;
    }
    if (command === "acquire") {
      if (current) throw new Error(`${key} already owned by ${current.owner}; no takeover performed`);
      const owner = get("owner", true)!;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(owner)) throw new Error("Owner must be a short run/worker identifier");
      const now = new Date().toISOString();
      const claim: Claim = { key: key!, owner, token: crypto.randomUUID(), session: "", createdAt: now, updatedAt: now, phase: "reserved", resources: [] };
      if (key === "coordinator") claim.session = get("session", true)!;
      if (key !== "coordinator") {
        claim.run = get("run", true)!;
        requireController(claim.run, true);
        claim.session = controller!.session;
        claim.base = git(repo, "rev-parse", "--verify", `${get("base", true)!}^{commit}`);
        claim.branch = get("branch", true)!;
        git(repo, "check-ref-format", "--branch", claim.branch);
        const worktree = get("worktree", true)!;
        if (!isAbsolute(worktree)) throw new Error("Worktree must be absolute");
        claim.worktree = await canonicalPath(worktree);
        const launchRoot = await realpath(git(repo, "rev-parse", "--show-toplevel"));
        const rel = relative(launchRoot.toLowerCase(), claim.worktree.toLowerCase());
        if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Use a separate worktree outside the launch checkout");
        if (claims.some(c => c.branch === claim.branch || c.worktree === claim.worktree)) throw new Error("Branch/worktree already reserved");
        claim.resources = [...new Set(await Promise.all((flags.get("resource") ?? []).map(r => resource(r, workspace))))];
        if (!claim.resources.some(r => r.startsWith("path:"))) throw new Error("Reserve at least one path resource");
        ensureResources(claim.resources);
      }
      await persist(claim);
      console.log(JSON.stringify({ common, ...claim }));
      return;
    }
    const claim = owned();
    if (command === "resume") {
      if (claim.key !== "coordinator") throw new Error("Resume transfers only coordinator ownership");
      const session = get("session", true)!;
      if (session === claim.session || !get("note")?.trim()) throw new Error("Resume needs a new session identity and stopped-owner evidence --note");
      if (claims.some(c => c.run === claim.owner && ["reserved", "working", "review"].includes(c.phase))) throw new Error("Stop workers and record blocked/ready handoffs before resume");
      claim.session = session;
      claim.token = crypto.randomUUID();
      claim.updatedAt = new Date().toISOString();
      claim.note = get("note")!.slice(0, 2000);
      await persist(claim);
      console.log(JSON.stringify(claim));
      return;
    }
    if (command === "adopt") {
      if (claim.key === "coordinator") throw new Error("Use resume for coordinator transfer");
      requireController(claim.run, true);
      if (!["ready", "blocked"].includes(claim.phase) || !get("note")?.trim()) throw new Error("Adopt only stopped ready/blocked work with an evidence note");
      claim.owner = get("owner", true)!;
      claim.session = controller!.session;
      claim.token = crypto.randomUUID();
      claim.updatedAt = new Date().toISOString();
      claim.note = get("note")!.slice(0, 2000);
      await persist(claim);
      console.log(JSON.stringify(claim));
      return;
    }
    if (command === "check") {
      if (claim.key !== "coordinator") {
        requireController(claim.run, false, claim.session);
        if (["integrated", "abandoned"].includes(claim.phase)) throw new Error("Claim is terminal; editing is not allowed");
        if (await realpath(git(repo, "rev-parse", "--show-toplevel")) !== await realpath(claim.worktree!)) throw new Error("Wrong worktree");
        if (git(repo, "branch", "--show-current") !== claim.branch) throw new Error("Wrong branch");
      }
      console.log(JSON.stringify({ valid: true, ...publicClaim(claim) }));
      return;
    }
    if (command === "update") {
      if (claim.key === "coordinator") throw new Error("Coordinator has no worker phase");
      requireController(claim.run, false, claim.session);
      if (["integrated", "abandoned"].includes(claim.phase)) throw new Error("Terminal claims cannot resume; release and reacquire deliberately");
      const phase = get("phase") ?? claim.phase;
      if (!phases.has(phase)) throw new Error("Invalid phase");
      if (["integrated", "abandoned"].includes(phase)) {
        requireController(claim.run, true);
        if (!get("note")?.trim()) throw new Error("Terminal phase requires evidence --note");
      }
      const resources = [...new Set([...claim.resources, ...await Promise.all((flags.get("resource") ?? []).map(r => resource(r, workspace)))])];
      ensureResources(resources, claim.key);
      claim.phase = phase;
      claim.resources = resources;
      claim.updatedAt = new Date().toISOString();
      if (get("note") !== undefined) claim.note = get("note")!.slice(0, 2000);
      await persist(claim);
      console.log(JSON.stringify(publicClaim(claim)));
      return;
    }
    if (claim.key === "coordinator") {
      if (claims.some(c => c.run === claim.owner && ["reserved", "working", "review"].includes(c.phase))) throw new Error("Active issue reservations remain; stop workers and record handoffs first");
    } else {
      requireController(claim.run, true, claim.session);
      if (!["integrated", "abandoned"].includes(claim.phase)) throw new Error("Only terminal issue claims can be released");
    }
    await rm(join(root, `${claim.key}.json`));
    console.log(JSON.stringify({ released: claim.key }));
  } finally {
    await rm(mutex, { recursive: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
