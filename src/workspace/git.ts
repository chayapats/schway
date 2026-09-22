import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Return the nearest ancestor containing a stat-able `.git` entry, or undefined when none is found.
 * Starts at the supplied directory without canonicalizing it; failed filesystem probes are skipped.
 */
export async function findGitRoot(start: string): Promise<string | undefined> {
  let dir = start;
  while (true) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }
}
