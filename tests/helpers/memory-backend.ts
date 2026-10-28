import type {
  ExecutionBackend,
  ExecutionFileObservation,
  ExecutionSpawnRequest,
  ExecutionSpawnResult,
} from "schway/host";

/** One recorded backend call with its first path or command argument. */
export interface MemoryCall { op: string; target: string }

type Entry = { kind: "file"; bytes: Uint8Array; version: number } | { kind: "dir" } | { kind: "link"; target: string };

/** Options for a scripted in-memory backend. */
export interface MemoryBackendOptions {
  root?: string;
  temporaryDirectory?: string;
  files?: Record<string, string>;
  /** Absolute link path → absolute target path. */
  links?: Record<string, string>;
  spawn?: (request: ExecutionSpawnRequest) => Promise<ExecutionSpawnResult>;
  /** Called after each observation, before the observation is returned. */
  afterObserve?: (path: string) => void;
}

/** In-memory backend that records every call, uses no host filesystem or process API, and fences stale writes. */
export function memoryBackend(options: MemoryBackendOptions = {}) {
  const root = options.root ?? "/workspace";
  const temporaryDirectory = options.temporaryDirectory ?? "/tmp";
  const entries = new Map<string, Entry>();
  const calls: MemoryCall[] = [];
  const versions = new WeakMap<ExecutionFileObservation, number | null>();
  let clock = 0;
  const encoder = new TextEncoder();
  const fail = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });
  const parent = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));
  const join = (...parts: string[]) => ("/" + parts.join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  const ensureDirs = (path: string) => {
    for (let current = path; ; current = parent(current)) {
      if (!entries.has(current)) entries.set(current, { kind: "dir" });
      if (current === "/") break;
    }
  };
  const setFile = (path: string, text: string | Uint8Array) => {
    ensureDirs(parent(path));
    entries.set(path, { kind: "file", bytes: typeof text === "string" ? encoder.encode(text) : text, version: ++clock });
  };
  ensureDirs(root);
  ensureDirs(temporaryDirectory);
  for (const [path, text] of Object.entries(options.files ?? {})) setFile(path.startsWith("/") ? path : join(root, path), text);
  for (const [path, target] of Object.entries(options.links ?? {})) { ensureDirs(parent(path)); entries.set(path, { kind: "link", target }); }

  /** Follow every link component; missing components reject ENOENT. */
  const real = (path: string, depth = 0): string => {
    if (depth > 32) throw fail("ELOOP", path);
    const parts = path.split("/").filter(Boolean);
    let current = "/";
    for (const [index, part] of parts.entries()) {
      const next = join(current, part);
      const entry = entries.get(next);
      if (!entry) throw fail("ENOENT", path);
      if (entry.kind === "link") {
        current = real(join(entry.target, ...parts.slice(index + 1)), depth + 1);
        return current;
      }
      if (entry.kind === "file" && index < parts.length - 1) throw fail("ENOTDIR", path);
      current = next;
    }
    return current;
  };
  const lookup = (path: string) => entries.get(real(path))!;
  /** Resolve links through the deepest existing ancestor so writes land where a real filesystem would put them. */
  const target = (path: string): string => {
    const tail: string[] = [];
    for (let current = path; ; current = parent(current)) {
      try { return join(real(current), ...tail.reverse()); }
      catch { if (current === "/") return path; tail.push(current.slice(current.lastIndexOf("/") + 1)); }
    }
  };
  const record = (op: string, target: string) => calls.push({ op, target });

  const backend: ExecutionBackend = {
    workspaceRoot: root,
    temporaryDirectory,
    async realpath(path) { record("realpath", path); return real(path); },
    async stat(path) {
      record("stat", path);
      const entry = lookup(path);
      return { type: entry.kind === "dir" ? "directory" : "file" };
    },
    async *readFile(path) {
      record("readFile", path);
      const entry = lookup(path);
      if (entry.kind === "dir") throw fail("EISDIR", path);
      if (entry.kind === "file") yield entry.bytes;
    },
    async observeFile(path, observeOptions) {
      record("observeFile", path);
      let entry: Entry | undefined;
      try { entry = lookup(path); } catch (error) { if ((error as { code?: string }).code === "ENOENT") entry = undefined; else throw error; }
      if (entry?.kind === "dir") throw fail("EISDIR", path);
      const observation: ExecutionFileObservation | null = entry === undefined
        ? null
        : { targetExists: true, ...(observeOptions?.content && entry.kind === "file" ? { bytes: entry.bytes.slice() } : {}) };
      if (observation) versions.set(observation, entry?.kind === "file" ? entry.version : null);
      options.afterObserve?.(path);
      return observation;
    },
    async writeFileAtomically(path, content, writeOptions = {}) {
      record("writeFileAtomically", path);
      let current: Entry | undefined;
      try { current = lookup(path); } catch { current = undefined; }
      if (writeOptions.observed !== undefined) {
        const expected = writeOptions.observed === null ? undefined : versions.get(writeOptions.observed);
        const actual = current?.kind === "file" ? current.version : undefined;
        if (expected !== actual) throw Object.assign(new Error("stale"), { code: "ECHANGED" });
      }
      const destination = target(path);
      if (!writeOptions.createParents && !entries.has(parent(destination))) throw fail("ENOENT", path);
      setFile(destination, content);
    },
    async writePrivateFile(path, content) { record("writePrivateFile", path); setFile(target(path), content); },
    async list(path) {
      record("list", path);
      const dir = real(path);
      const prefix = dir === "/" ? "/" : `${dir}/`;
      return [...entries.entries()]
        .filter(([name]) => name.startsWith(prefix) && name !== dir && !name.slice(prefix.length).includes("/"))
        .map(([name, entry]) => ({ name: name.slice(prefix.length), type: entry.kind === "dir" ? "directory" as const : entry.kind === "link" ? "symlink" as const : "file" as const }));
    },
    async *glob(pattern, globOptions) {
      record("glob", globOptions.cwd);
      const matcher = new Bun.Glob(pattern);
      const prefix = `${real(globOptions.cwd)}/`;
      for (const [name, entry] of entries) {
        if (entry.kind === "file" && name.startsWith(prefix) && matcher.match(name.slice(prefix.length))) yield name.slice(prefix.length);
      }
    },
    async search(request) {
      record("search", request.path);
      const base = request.path.startsWith("/") ? request.path : join(request.cwd, request.path);
      const regex = new RegExp(request.pattern, request.ignoreCase ? "i" : "");
      const matches: { path: string; line: number; text: string }[] = [];
      for (const [name, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
        if (entry.kind !== "file" || !(name === base || name.startsWith(`${base}/`))) continue;
        for (const [index, line] of new TextDecoder().decode(entry.bytes).split("\n").entries()) {
          if (!regex.test(line)) continue;
          matches.push({ path: name.slice(request.cwd.length + 1), line: index + 1, text: line });
          if (matches.length >= request.limit) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    },
    async spawn(request) {
      record("spawn", request.command);
      return options.spawn ? options.spawn(request) : { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
  return {
    backend,
    calls,
    /** Text of a stored file, or undefined when absent. */
    text: (path: string) => { const entry = entries.get(path); return entry?.kind === "file" ? new TextDecoder().decode(entry.bytes) : undefined; },
    /** Replace a file outside the tools, bumping its version. */
    setFile,
  };
}
