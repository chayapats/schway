import { readFile } from "node:fs/promises";

/** Parse KEY=VALUE lines from an explicit env file. Comments and blanks are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = assignment.slice(0, separator).trim();
    if (key.length === 0) {
      continue;
    }
    result[key] = unquote(assignment.slice(separator + 1));
  }
  return result;
}

/**
 * Return a copy of `env` overlaid by explicit env files in order, with later files winning per key.
 * Paths are used as supplied; any unreadable file returns an error without mutating the input environment.
 */
export async function applyEnvFiles(
  paths: readonly string[],
  env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined> | { error: string }> {
  const next: Record<string, string | undefined> = { ...env };
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { error: `Unable to read env file ${path}` };
    }
    Object.assign(next, parseEnvFile(text));
  }
  return next;
}

/** Strip a matching pair of single or double quotes from an env value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
