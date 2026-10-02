import { resolve } from "node:path";

/** Describe a supported legacy setting and the major version allowed to remove it. */
export interface ConfigDeprecation {
  key: string;
  replacement?: string;
  since: string;
  removeIn: string;
}

/** List real deprecated settings; empty until a supported setting is deprecated. */
export const CONFIG_DEPRECATIONS: readonly ConfigDeprecation[] = [];

/** Carry the same source-specific deprecation message across all configuration surfaces. */
export interface ConfigDeprecationWarning extends ConfigDeprecation {
  path: string;
  message: string;
}

/** Read an own dotted property without traversing inherited objects. */
function location(object: Record<string, unknown>, key: string): { parent: Record<string, unknown>; key: string } | undefined {
  const parts = key.split(".");
  let parent = object;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, part)) return undefined;
    const next = parent[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
    parent = next as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  return Object.hasOwn(parent, last) ? { parent, key: last } : undefined;
}

/** Translate legacy keys on a copy, preserving explicit replacements and original file bytes. */
export function applyConfigDeprecations(value: Record<string, unknown>, source: string, table: readonly ConfigDeprecation[]): {
  value: Record<string, unknown>; warnings: ConfigDeprecationWarning[];
} {
  const copy = structuredClone(value);
  const warnings: ConfigDeprecationWarning[] = [];
  for (const entry of table) {
    const old = location(copy, entry.key);
    if (!old) continue;
    const explicit = entry.replacement !== undefined && location(value, entry.replacement) !== undefined;
    const path = resolve(source);
    const message = entry.replacement
      ? `Config: "${entry.key}" in ${path} is deprecated; use "${entry.replacement}". It will be removed in ${entry.removeIn}.`
      : `Config: "${entry.key}" in ${path} is deprecated and has no replacement. It will be removed in ${entry.removeIn}.`;
    warnings.push({ ...entry, path, message: message + (explicit ? ` "${entry.key}" is ignored because "${entry.replacement}" is set.` : "") });
    const previous = old.parent[old.key];
    // Without a replacement an existing schema key retains its behavior.
    if (!entry.replacement) continue;
    delete old.parent[old.key];
    const oldParts = entry.key.split(".");
    for (let length = oldParts.length - 1; length > 0; length--) {
      const ancestor = location(copy, oldParts.slice(0, length).join("."));
      if (!ancestor || Object.keys(ancestor.parent[ancestor.key] as object).length) break;
      delete ancestor.parent[ancestor.key];
    }
    if (explicit) continue;
    const parts = entry.replacement.split(".");
    let parent = copy;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part)) Object.defineProperty(parent, part, { value: {}, enumerable: true, writable: true, configurable: true });
      const next = parent[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`Invalid config at ${source}: ${part} must be an object`);
      parent = next as Record<string, unknown>;
    }
    Object.defineProperty(parent, parts.at(-1)!, { value: previous, enumerable: true, writable: true, configurable: true });
  }
  return { value: copy, warnings };
}
