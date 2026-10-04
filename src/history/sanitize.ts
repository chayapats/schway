import { redactSecrets } from "../auth/secrets.ts";
import { sessionTaskPreview } from "../session/discovery.ts";
import { MAX_HISTORY_COMMAND_CHARS, MAX_HISTORY_DETAIL_CHARS, MAX_HISTORY_EXCERPT_GRAPHEMES, MAX_HISTORY_PATH_BYTES } from "./records.ts";

// Zero-width joiners stay: they bind emoji and Indic clusters and cannot reorder or hide text.
const CONTROLS = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const CREDENTIAL_TOKENS = /\b(?:sk-[\w-]{8,}|xai-[\w-]{8,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)|\b(Bearer)\s+\S+|([?&#](?:code|token|access_token|refresh_token|id_token)=)[^\s&#]+/gi;

/** Known secrets plus trimmed variants, longest first so overlapping values are masked completely. */
function variants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap(secret => [secret, secret.trim()]).filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Redact known secrets, strip terminal sequences and controls, then redact again in case stripping rejoined a secret. */
function clean(value: string, secrets: readonly string[], control: (character: string) => string): string {
  const known = variants(secrets);
  const stripped = Bun.stripANSI(redactSecrets(value, known)).replace(CONTROLS, control).toWellFormed();
  return redactSecrets(stripped, known).replace(CREDENTIAL_TOKENS, (_match, bearer?: string, query?: string) => bearer ? `${bearer} ***` : query ? `${query}***` : "***");
}

/** Keep whole graphemes while both the grapheme and code-point counts stay within `max`. */
function cutGraphemes(text: string, max: number): { text: string; truncated: boolean } {
  let result = "", graphemes = 0, points = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const size = [...segment].length;
    if (graphemes + 1 > max || points + size > max) return { text: result, truncated: true };
    result += segment; graphemes++; points += size;
  }
  return { text: result, truncated: false };
}

/** Sanitized task excerpt of at most 160 graphemes, hidden for slash commands and credential-like text. */
export function historyExcerpt(task: string, secrets: readonly string[]): { text?: string; truncated: boolean; hidden: boolean } {
  if (!task.trim()) return { truncated: false, hidden: false };
  if (sessionTaskPreview(task, secrets) === undefined) return { truncated: false, hidden: true };
  const normalized = clean(task, secrets, character => /\p{White_Space}/u.test(character) ? " " : "").replace(/\s+/g, " ").trim();
  const cut = cutGraphemes(normalized, MAX_HISTORY_EXCERPT_GRAPHEMES);
  return { ...(cut.text ? { text: cut.text } : {}), truncated: cut.truncated, hidden: false };
}

/** Single-line command summary of at most 200 code points, cut at a grapheme boundary after redaction. */
export function historyCommandSummary(command: string, secrets: readonly string[]): { text: string; truncated: boolean } {
  const normalized = clean(command, secrets, () => " ").replace(/\s+/g, " ").trim();
  return cutGraphemes(normalized || "bash", MAX_HISTORY_COMMAND_CHARS);
}

/** Display-safe path with controls replaced; undefined when it exceeds 4096 bytes and must be omitted whole. */
export function historyPath(path: string, secrets: readonly string[]): string | undefined {
  const safe = clean(path, secrets, () => "�");
  return safe && Buffer.byteLength(safe) <= MAX_HISTORY_PATH_BYTES ? safe : undefined;
}

/** Bounded single-line diagnostic for unavailable Git evidence. */
export function historyDetail(detail: string, secrets: readonly string[]): string | undefined {
  const normalized = clean(detail, secrets, () => " ").replace(/\s+/g, " ").trim();
  return normalized ? cutGraphemes(normalized, MAX_HISTORY_DETAIL_CHARS).text : undefined;
}
