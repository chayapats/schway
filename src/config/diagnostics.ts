import type { TSchema } from "@sinclair/typebox";
import { ValueErrorType, type ValueError } from "@sinclair/typebox/errors";
import { stripVTControlCharacters } from "node:util";
import { CREDENTIAL_HEADER_NAMES, redactSecrets } from "../auth/secrets.ts";

/** Safe configuration repair data; paths contain only schema names and redacted dynamic segments. */
export interface ConfigDiagnostic {
  source: string;
  path: string;
  category: "json" | "root" | "unknown-setting" | "enum" | "type" | "range" | "constraint" | "secret" | "unreadable" | "removed-provider" | "deprecated";
  constraint: string;
  values?: readonly string[];
}

/** Retain the established printable error while carrying reasons for diagnostic consumers. */
export interface ConfigReadError { error: string; diagnostics: readonly ConfigDiagnostic[] }

/** Explicit environment and expandable known-secret list; diagnostic formatting never reads ambient credentials. */
export interface ConfigDiagnosticContext {
  env?: Record<string, string | undefined>;
  /** Prior explicit environment snapshots contribute known secrets only, never effective configuration or auth values. */
  observedEnvs?: readonly Readonly<Record<string, string | undefined>>[];
  secrets?: string[];
}

/** Remember raw and effective credential values from explicit inputs and own valid profile environment references. */
export function configDiagnosticSecrets(context: ConfigDiagnosticContext = {}, inputs: readonly unknown[] = []): string[] {
  const values = [...(context.secrets ?? [])];
  const envNames = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"]);
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const inspect = (value: Record<string, unknown>) => {
    if (Object.hasOwn(value, "apiKey") && typeof value.apiKey === "string") values.push(value.apiKey);
    if (Object.hasOwn(value, "headers") && object(value.headers)) for (const [name, header] of Object.entries(value.headers)) {
      if (!CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase()) || typeof header !== "string") continue;
      values.push(header);
      const token = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(header.trim())?.[1];
      if (token) values.push(token);
    }
    if (Object.hasOwn(value, "credentialEnv") && typeof value.credentialEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.credentialEnv)) envNames.add(value.credentialEnv);
  };
  for (const input of inputs) if (object(input)) {
    inspect(input);
    if (Object.hasOwn(input, "profiles") && object(input.profiles)) for (const profile of Object.values(input.profiles)) if (object(profile)) inspect(profile);
  }
  for (const env of [context.env, ...(context.observedEnvs ?? [])]) for (const name of envNames) {
    const value = env && Object.hasOwn(env, name) ? env[name] : undefined;
    if (value) values.push(value);
  }
  const secrets = [...new Set(values.flatMap(value => [value, value.trim()]).filter(Boolean))].sort((a, b) => b.length - a.length);
  context.secrets ??= [];
  context.secrets.splice(0, context.secrets.length, ...secrets);
  return secrets;
}

/** Bound source labels and remove terminal controls, recognizable credentials and URL secrets. */
export function safeConfigSource(source: string, secrets: readonly string[] = []): string {
  const space = "[\\s\\x00-\\x1f\\x7f-\\x9f]";
  const prefix = (word: string) => [...word].join("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]*");
  const scheme = `(?:${["Bearer", "Basic", "Token"].map(prefix).join("|")})`;
  // Match split prefixes and complete tokens before removing controls, so a header cannot consume only a credential fragment.
  const credentialHeader = new RegExp(`\\b(?:${[...CREDENTIAL_HEADER_NAMES].map(prefix).join("|")})${space}*[:=]${space}*(?:${scheme}${space}+)?[^\\s]+`, "giu");
  const credentialScheme = new RegExp(`\\b${scheme}${space}+[^\\s]+`, "giu");
  const redactCredentials = (value: string) => value.replace(credentialHeader, "<redacted>").replace(credentialScheme, "<redacted>").replace(/\bsk-[\w-]+/g, "<redacted>");
  // Preserve separators until credential recognition; normalization must not join a scheme to its token.
  const known = [...new Set(secrets.flatMap(value => [value, value.trim(), stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")]).filter(Boolean))].sort((a, b) => b.length - a.length);
  const redacted = redactCredentials(stripVTControlCharacters(redactSecrets(source, known)).replace(/\p{Cf}/gu, ""));
  // Keep semantic whitespace until another recognition pass; deleting a newline would join Bearer to its token.
  const normalized = redacted.replace(/[\p{Cc}\p{Cf}]/gu, control => /\s/u.test(control) ? control : "");
  return redactSecrets(redactCredentials(redactCredentials(normalized).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ""))
    .replace(/https?:\/\/[^\s]+/gi, value => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "<redacted URL>"; }
    }), known).slice(0, 512);
}

/** Construct a diagnostic from trusted schema paths and guidance, never invalid input values. */
export function configDiagnostic(source: string, path: string, category: ConfigDiagnostic["category"], constraint: string, values?: readonly string[]): ConfigDiagnostic {
  return { source: safeConfigSource(source), path, category, constraint, ...(values ? { values } : {}) };
}

/** Explain one field failure with its repair action, independent of validator wording. */
export function configDiagnosticSummary(diagnostic: ConfigDiagnostic): string {
  return `Invalid ${diagnostic.path || "configuration"} · ${diagnostic.constraint}`;
}

/** Format already sanitized reasons for existing startup and configuration-editor callers. */
export function configReadError(diagnostics: readonly ConfigDiagnostic[]): ConfigReadError {
  return { error: diagnostics.map(d => `Invalid config at ${d.source}: ${configDiagnosticSummary(d)}`).join("\n"), diagnostics };
}

/** Keep recognized property names while hiding arbitrary profile, header, array and unknown segments. */
function schemaPath(root: TSchema, pointer: string): string {
  let schema: TSchema | undefined = root;
  const safe: string[] = [];
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (schema?.properties && Object.hasOwn(schema.properties, key)) { safe.push(key); schema = schema.properties[key]; }
    else {
      safe.push("<unknown setting>");
      schema = schema?.items ?? (schema?.patternProperties ? Object.values(schema.patternProperties)[0] as TSchema : undefined);
      if (!schema) break;
    }
  }
  return safe.join(".");
}

/** Translate schema failures without exposing values, unknown keys or raw validator prose. */
export function schemaDiagnostics(root: TSchema, errors: Iterable<ValueError>, source: string): ConfigDiagnostic[] {
  const diagnostics = new Map<string, ConfigDiagnostic>();
  for (const error of errors) {
    if (diagnostics.has(error.path)) continue;
    const schema = error.schema;
    // A literal's `displayValue` is the accepted input users read in repair text; the stored value stays `const`.
    const literals = (node: TSchema): string[] => node.anyOf ? node.anyOf.flatMap(literals) : typeof node.const === "string" ? [typeof node.displayValue === "string" ? node.displayValue : node.const] : [];
    const values = literals(schema);
    if (!values.length && error.type === ValueErrorType.Union) {
      const branch = schema.anyOf.findIndex((part: TSchema) => part.type === (error.value === null ? "null" : typeof error.value));
      if (branch >= 0 && error.errors[branch]) {
        for (const diagnostic of schemaDiagnostics(root, error.errors[branch]!, source)) diagnostics.set(error.path, diagnostic);
        continue;
      }
    }
    let category: ConfigDiagnostic["category"] = "type", constraint: string;
    if (error.type === ValueErrorType.ObjectAdditionalProperties) { category = "unknown-setting"; constraint = `Remove this unknown setting; use a documented setting name${schema.properties ? `: ${Object.keys(schema.properties).join(", ")}` : ""}`; }
    else if (values.length) {
      category = "enum";
      constraint = `Use ${values.length > 2 ? `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}` : values.join(" or ")}`;
    } else if ([ValueErrorType.IntegerMinimum, ValueErrorType.NumberMinimum].includes(error.type)) { category = "range"; constraint = `Use ${schema.type === "integer" ? "an integer" : "a number"} of ${schema.minimum} or greater`; }
    else if (error.type === ValueErrorType.StringPattern) { category = "constraint"; constraint = `Use a string matching ${schema.pattern}`; }
    else if (error.type === ValueErrorType.StringMinLength) { category = "constraint"; constraint = `Use a nonempty string`; }
    else if (error.type === ValueErrorType.StringMaxLength) { category = "constraint"; constraint = `Use at most ${schema.maxLength} characters`; }
    else if (error.type === ValueErrorType.ArrayUniqueItems) { category = "constraint"; constraint = "Remove duplicate entries"; }
    else {
      const type = schema.type ?? (schema.anyOf?.some((s: TSchema) => s.type === "string") ? "string" : "object");
      constraint = `Use ${type === "object" ? "a JSON object" : type === "integer" ? "an integer" : type === "array" ? "an array" : `a ${type}`}`;
    }
    diagnostics.set(error.path, configDiagnostic(source, schemaPath(root, error.path), category, constraint, values.length ? values : undefined));
  }
  return [...diagnostics.values()];
}
