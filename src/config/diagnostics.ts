import type { TSchema } from "@sinclair/typebox";
import { ValueErrorType, type ValueError } from "@sinclair/typebox/errors";

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

/** Bound source labels and remove terminal controls, recognizable credentials and URL secrets. */
export function safeConfigSource(source: string): string {
  return source.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/https?:\/\/[^\s]+/gi, value => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "<redacted URL>"; }
    }).replace(/\bsk-[\w-]+/g, "<redacted>").replace(/\b(?:Bearer|Basic|Token)\s+\S+/gi, "<redacted>").slice(0, 512);
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
    const literals = (node: TSchema): string[] => node.anyOf ? node.anyOf.flatMap(literals) : typeof node.const === "string" ? [node.const] : [];
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
