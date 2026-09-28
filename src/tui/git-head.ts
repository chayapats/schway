import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Read the checked-out branch (or a 7-character detached SHA) from `root/.git` without spawning Git; undefined outside a repository. */
export function readGitHead(root: string): string | undefined {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      // Worktrees and submodules store a pointer file instead of a directory.
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
    if (ref) return ref;
    return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined;
  } catch { return undefined; }
}
