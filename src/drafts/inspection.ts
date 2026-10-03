import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Read-only checkpoint evidence; draft bytes never leave the inspector. */
export type DraftInspection =
  | { status: "missing" }
  | { status: "unverifiable" }
  | { status: "valid"; workspaceRoot: string; sessionId: string; present: boolean };

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

/** Inspect a bounded private envelope without recovery, mutation, or requiring its saved workspace to exist. */
export function inspectDraftCheckpoint(options: { home: string; workspaceRoot: string; sessionId: string }): DraftInspection {
  const descriptors: number[] = [];
  try {
    let path = realpathSync(options.home);
    let directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(directory);
    for (const name of [".schway", "drafts"]) {
      path = join(process.platform === "linux" ? `/proc/self/fd/${directory}` : path, name);
      directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(directory);
      const stat = fstatSync(directory);
      if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (name === "drafts" && (stat.mode & 0o077) !== 0)) return { status: "unverifiable" };
    }
    const identity = createHash("sha256").update(JSON.stringify([options.workspaceRoot, options.sessionId])).digest("hex");
    const file = openSync(join(process.platform === "linux" ? `/proc/self/fd/${directory}` : path, `${identity}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    descriptors.push(file);
    const before = fstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > MAX_CHECKPOINT_BYTES
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) return { status: "unverifiable" };
    const bytes = Buffer.alloc(before.size);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(file, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(file);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return { status: "unverifiable" };
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unverifiable" };
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== 1 || envelope.workspaceRoot !== options.workspaceRoot || envelope.sessionId !== options.sessionId) return { status: "unverifiable" };
    if (envelope.cleared === true && envelope.text === undefined) return { status: "valid", workspaceRoot: options.workspaceRoot, sessionId: options.sessionId, present: false };
    if (envelope.cleared !== undefined || typeof envelope.text !== "string" || typeof envelope.savedAt !== "string") return { status: "unverifiable" };
    return { status: "valid", workspaceRoot: options.workspaceRoot, sessionId: options.sessionId, present: envelope.text.length > 0 };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverifiable" };
  } finally {
    for (const descriptor of descriptors.reverse()) closeSync(descriptor);
  }
}
