import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Enduring identity prompt. Volatile project data stays out of this string. */
export const STABLE_SYSTEM_PROMPT = `You are Schway, a coding agent.

- Inspect relevant files before making targeted changes.
- Use tools efficiently.
- Follow project instructions.
- Report outcomes clearly.`;

/** Name of Schway's built-in web fetch tool, whose presence turns on the web-lookup line. */
export const BUILTIN_WEB_FETCH_TOOL_NAME = "web_fetch";

/** Base-prompt line steering web lookups to `web_fetch` instead of curl-scraped search pages. */
export const WEB_LOOKUP_GUIDANCE = "- For web lookups, use `web_fetch` on a specific page or API, not curl against search-engine result pages.";

/** Report whether built-in tool definitions, gathered before any extension registers tools, include `web_fetch`. */
export function hasBuiltinWebFetch(builtins: Iterable<{ readonly name: string }>): boolean {
  for (const definition of builtins) {
    if (definition.name === BUILTIN_WEB_FETCH_TOOL_NAME) return true;
  }
  return false;
}

/** Options that shape Schway's own base prompt; a SYSTEM.md replacement ignores them. */
export interface SystemPromptOptions {
  /** Append the web-lookup line; session builders set it from the built-in registry. */
  webLookupGuidance?: boolean;
}

/**
 * Build the system prompt from the supplied home's `.schway/SYSTEM.md` and `.schway/APPEND_SYSTEM.md` overrides.
 * A readable nonempty SYSTEM.md replaces the base prompt, including the web-lookup line; APPEND_SYSTEM.md follows it.
 * Missing, empty, or unreadable files are ignored, as are project-local replacements.
 */
export async function assembleSystemPrompt(home?: string, options: SystemPromptOptions = {}): Promise<string> {
  const builtin = options.webLookupGuidance ? `${STABLE_SYSTEM_PROMPT}\n${WEB_LOOKUP_GUIDANCE}` : STABLE_SYSTEM_PROMPT;
  if (home === undefined) {
    return builtin;
  }
  const replacement = await readOptionalText(join(home, ".schway", "SYSTEM.md"));
  const append = await readOptionalText(join(home, ".schway", "APPEND_SYSTEM.md"));
  const base = replacement ?? builtin;
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
