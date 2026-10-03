import { stripVTControlCharacters } from "node:util";
import { resolveProviderCredential, selectOpenAITransport, selectXaiTransport, type OpenAIAuthPreference, type XaiAuthPreference } from "../auth/credentials.ts";
import { createNativeCredentialStore, type CredentialStore, type CredentialTarget } from "../auth/store.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { configDiagnosticSecrets } from "../config/diagnostics.ts";
import { listCatalog } from "./catalog.ts";
import { abortableCatalogOperation, fetchProviderModelListResult, requireOpenAIApiKeyModels, requireXaiModels, type ListedModel, type ModelListFetch, type ModelListResult } from "./model-list.ts";
import type { ThinkingLevel } from "./model.ts";

/** Selected authentication identity, or no identity established by an offline/error result. */
export type CatalogRoute = "api-key" | "codex" | "grok" | "compatible" | "unresolved";
/** Copyable model ID with only observed, validated capability fields. */
export interface CatalogModel {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  supportedThinking?: readonly ThinkingLevel[];
  recommended?: boolean;
}
/** Version-one models-list object; null provider is reserved for errors before provider resolution. */
export interface ModelCatalog {
  schemaVersion: 1;
  provider: CredentialTarget["provider"] | null;
  route: CatalogRoute;
  profile?: string;
  source: "remote" | "builtin";
  status: "complete" | "partial" | "error";
  models: CatalogModel[];
  warnings: string[];
}
/** Resolved connection fields sufficient for discovery without a configured execution model. */
export interface CatalogConnection extends CredentialTarget {
  headers?: Record<string, string>;
  auth?: "required" | "optional" | "none";
  credentialEnv?: string;
  openaiAuth?: OpenAIAuthPreference;
  xaiAuth?: XaiAuthPreference;
}
/** Catalog result and optional safe stderr guidance; the error is outside the JSON envelope. */
export interface CatalogOutcome { catalog: ModelCatalog; error?: string }
/** Injectable catalog transport and deadline seams; production always starts a five-second budget. */
export interface CatalogDiscoveryDeps {
  store?: CredentialStore;
  fetch?: ModelListFetch;
  startDeadline?: (milliseconds: number) => { signal: AbortSignal; clear(): void };
}

function startDeadline(milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Model discovery timed out", "TimeoutError")), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function displaySecret(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

/** Keep raw, trimmed and display-normalized credentials without matching empty or whitespace-only values. */
function secretVariants(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap(value => {
    if (!value?.trim()) return [];
    const normalized = displaySecret(value);
    return [value, value.trim(), normalized, normalized.trim()].filter(variant => !!variant.trim());
  }))];
}

/** Infer env-name secrets only when trimmed raw and display-normalized values both contain at least eight characters. */
export function heuristicCatalogSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    /key|token|secret|password/i.test(name) && value && value.trim().length >= 8 && displaySecret(value).trim().length >= 8 ? [value] : []);
}

/** Remove raw/trimmed credentials, terminal controls and URLs from operational diagnostics. */
export function safeCatalogMessage(message: string, secrets: readonly string[] = []): string {
  const known = secretVariants(secrets);
  const normalized = stripVTControlCharacters(redactSecrets(message, known))
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return redactSecrets(normalized, known);
}

function explicitRoute(input: CatalogConnection): CatalogRoute {
  if (input.provider === "openai-compatible") return "compatible";
  const preference = input.provider === "openai" ? input.openaiAuth : input.xaiAuth;
  return preference && preference !== "auto" ? preference : "unresolved";
}

function publicModel(model: ListedModel): CatalogModel {
  return {
    id: model.id,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    ...(model.supportedThinking?.length ? { supportedThinking: model.supportedThinking } : {}),
    ...(model.recommended !== undefined ? { recommended: model.recommended } : {}),
  };
}

/** Read one route's catalog without inference, account fallback, TUI memory or other application writes. */
export async function discoverModels(input: CatalogConnection & {
  env: Record<string, string | undefined>; runtimeApiKey?: string; offline?: boolean; filter?: string; signal?: AbortSignal;
  /** Already observed invocation secrets, copied before adding selected credential observations. */
  knownSecrets?: readonly string[];
}, deps: CatalogDiscoveryDeps = {}): Promise<CatalogOutcome> {
  const secrets = secretVariants([...(input.knownSecrets ?? []), input.runtimeApiKey, ...Object.values(input.headers ?? {}),
    ...configDiagnosticSecrets({ env: input.env }, [input]), ...heuristicCatalogSecrets(input.env)]);
  const catalog: ModelCatalog = {
    schemaVersion: 1, provider: input.provider, route: explicitRoute(input),
    ...(input.profile ? { profile: input.profile } : {}), source: input.offline ? "builtin" : "remote",
    status: "complete", models: [], warnings: [],
  };
  const outcome = (error?: string): CatalogOutcome => {
    if (catalog.profile && secrets.some(secret => catalog.profile!.includes(secret))) {
      delete catalog.profile;
      if (catalog.status === "complete") catalog.status = "partial";
      catalog.warnings.push("Omitted profile name containing a credential value. Choose a different profile name.");
    }
    return { catalog, ...(error ? { error } : {}) };
  };
  const finish = (): CatalogOutcome => {
    catalog.models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (input.filter !== undefined) {
      const filter = input.filter.toLowerCase();
      catalog.models = catalog.models.filter(model => model.id.toLowerCase().includes(filter));
      if (!catalog.models.length) catalog.warnings.push("No models match. Remove --filter to see the full catalog.");
    }
    return outcome();
  };
  if (input.signal?.aborted) {
    const error = "Model discovery cancelled. Retry schway models list.";
    catalog.status = "error"; catalog.warnings = [error];
    return outcome(error);
  }
  if (input.offline) {
    catalog.warnings.push("Built-in; account access unverified. Run without --offline to check the selected account.");
    if (input.provider === "openai" && catalog.route !== "codex") {
      catalog.models = listCatalog().filter(model => model.provider === "openai").map(({ id, contextWindow, maxOutput }) => ({ id, contextWindow, maxOutput }));
    }
    if (!catalog.models.length) catalog.warnings.push("No local catalog for this route. Run without --offline to request its models.");
    return finish();
  }

  const deadline = (deps.startDeadline ?? startDeadline)(5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const rememberCredential = (value: string) => {
    secrets.push(...secretVariants([value]));
    try {
      const tokens = JSON.parse(value);
      for (const field of [tokens?.accessToken, tokens?.refreshToken, tokens?.accountId]) if (typeof field === "string") secrets.push(...secretVariants([field]));
    } catch { /* API keys are not token objects. */ }
  };
  try {
    signal.throwIfAborted();
    const originalStore = deps.store ?? createNativeCredentialStore();
    const reads = new Map<string, Promise<string | null>>();
    const store: CredentialStore = {
      get(identity) {
        signal.throwIfAborted();
        let pending = reads.get(identity.account);
        if (!pending) {
          pending = originalStore.get(identity).then(value => {
            if (value) rememberCredential(value);
            return value;
          });
          reads.set(identity.account, pending);
        }
        return abortableCatalogOperation(pending, signal);
      },
      async set(identity, value) {
        signal.throwIfAborted();
        rememberCredential(value);
        await originalStore.set(identity, value);
        reads.set(identity.account, Promise.resolve(value));
      },
      async delete() { throw new Error("Model discovery cannot delete credentials."); },
    };
    let result: ModelListResult;
    if (input.provider === "openai") {
      const selected = await selectOpenAITransport({ ...input, store, minimalLookup: true });
      if ("error" in selected) throw new Error(selected.error);
      catalog.route = selected.transport;
    } else if (input.provider === "xai") {
      const selected = await selectXaiTransport({ ...input, store });
      if ("error" in selected) throw new Error(selected.error);
      catalog.route = selected.transport;
    }
    signal.throwIfAborted();
    if (catalog.route === "codex") {
      const provider = await import("./providers/codex-subscription.ts");
      signal.throwIfAborted();
      result = await provider.fetchDiscoveryCatalog({ store, fetch: deps.fetch, signal });
    } else if (catalog.route === "grok") {
      const provider = await import("./providers/grok-subscription.ts");
      signal.throwIfAborted();
      result = await provider.fetchDiscoveryCatalog({ store, lifecycleStore: originalStore, onCredential: rememberCredential, fetch: deps.fetch, signal });
    } else {
      let url = input.provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.x.ai/v1/models";
      if (input.provider === "openai-compatible") {
        try {
          const endpoint = new URL(input.baseUrl ?? "");
          if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
          endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/models`;
          url = endpoint.href;
        } catch { throw new Error("Set a valid HTTP(S) --base-url without credentials, query parameters or fragments."); }
      }
      const credential = await resolveProviderCredential({ ...input, store });
      if ("error" in credential) throw new Error(credential.error);
      if (credential.apiKey) rememberCredential(credential.apiKey);
      signal.throwIfAborted();
      result = await fetchProviderModelListResult({ url, apiKey: credential.apiKey, headers: input.headers, fetch: deps.fetch, signal, parseOptions: input.provider === "openai-compatible" ? undefined : { chatOnly: input.provider }, label: input.provider === "openai" ? "OpenAI" : input.provider === "xai" ? "xAI" : "Compatible" });
      if (input.provider === "openai") result.models = requireOpenAIApiKeyModels(result.models);
      if (input.provider === "xai") result.models = requireXaiModels(result.models);
    }
    signal.throwIfAborted();
    catalog.models = result.models.filter(model => !secrets.some(secret => secret.length > 0 && model.id.includes(secret))).map(publicModel);
    catalog.status = result.partial ? "partial" : "complete";
    catalog.warnings = result.warnings;
    if (catalog.models.length !== result.models.length) {
      if (!catalog.models.length) throw new Error("No safe selectable models were returned. Check the endpoint and retry schway models list.");
      catalog.status = "partial";
      catalog.warnings.push("Discarded model IDs containing credential values. Check the endpoint and retry schway models list.");
    }
    return finish();
  } catch (error) {
    const failure = input.signal?.aborted ? "Model discovery cancelled. Retry schway models list."
      : deadline.signal.aborted ? "Model discovery timed out after 5 seconds. Retry schway models list."
        : error instanceof Error ? error.message : "Model discovery failed. Retry schway models list.";
    let message = input.signal?.aborted || deadline.signal.aborted ? failure : safeCatalogMessage(failure, secrets);
    if (/HTTP (401|403)\b/.test(failure)) message += " Check credentials for this route; no billing fallback was used.";
    else if (/HTTP 429\b/.test(failure)) message += " Wait for the rate limit to reset, then retry schway models list.";
    else if (!/retry|sign in|pass --|set |unlock|select /i.test(message)) message += " Retry schway models list.";
    catalog.status = "error"; catalog.models = []; catalog.warnings = [message];
    return outcome(message);
  } finally { deadline.clear(); }
}
