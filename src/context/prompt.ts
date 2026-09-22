import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Enduring identity prompt. Volatile project data stays out of this string. */
export const STABLE_SYSTEM_PROMPT = `You are Schway, a coding agent.

- Inspect relevant files before making targeted changes.
- Use tools efficiently.
- Follow project instructions.
- Report outcomes clearly.`;

/**
 * Build the system prompt from the supplied home's `.schway/SYSTEM.md` and `.schway/APPEND_SYSTEM.md` overrides.
 * A readable nonempty SYSTEM.md replaces the base prompt; APPEND_SYSTEM.md follows it.
 * Missing, empty, or unreadable files are ignored, as are project-local replacements.
 */
export async function assembleSystemPrompt(home?: string): Promise<string> {
  if (home === undefined) {
    return STABLE_SYSTEM_PROMPT;
  }
  const replacement = await readOptionalText(join(home, ".schway", "SYSTEM.md"));
  const append = await readOptionalText(join(home, ".schway", "APPEND_SYSTEM.md"));
  const base = replacement ?? STABLE_SYSTEM_PROMPT;
  if (append === undefined) {
    return base;
  }
  return `${base.replace(/\s+$/, "")}\n\n${append.replace(/\s+$/, "")}`;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return undefined;
    }
    const content = await readFile(path, "utf8");
    return content.trim().length === 0 ? undefined : content;
  } catch {
    return undefined;
  }
}
