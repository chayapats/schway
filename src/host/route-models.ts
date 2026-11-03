import { checkAuthReadiness, classifyAuthError, credentialOwner, credentialReferenceForRoute, effectiveStore, validateAuthSelection,
  type HostAuthRoute, type HostAuthSelection, type HostAuthStatusCode } from "./auth-routes.ts";
import { credentialWriteRefusedError } from "../auth/store.ts";
import type { ModelCapability } from "../model/catalog.ts";
import { xaiModelCapabilities, type ListedModel } from "../model/model-list.ts";
import { effortSupport, outputCapSupport, registerCatalogEvidence, type HostEffortSupport, type HostOutputCapSupport } from "./route-capabilities.ts";

/** One selectable account model with the shared route recommendation, observed context limit and exact effort support. */
export interface HostModelChoice {
  readonly id: string;
  readonly recommended: boolean;
  readonly contextWindow?: number;
  /** Effort the adapter accepts for this model given this listing; pass the choice as `catalogModel` to use it. */
  readonly effort: HostEffortSupport;
  /** Whether this route sends a provider-enforced output cap for this model, with its default and maximum. */
  readonly outputCap: HostOutputCapSupport;
}

/** Largest Codex catalog body Schway reads, the adapter's own catalog limit. */
const MAX_CODEX_CATALOG_BYTES = 1_048_576;

/** Read a copy of the catalog body under the adapter's size bound; discovery reads the original untouched. */
async function catalogBytes(response: Response): Promise<Uint8Array | undefined> {
  if (!response.ok || !response.body) return undefined;
  const reader = response.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // Over the bound, no evidence is kept; discovery reports its own failure for the original body.
      if (size > MAX_CODEX_CATALOG_BYTES) { void reader.cancel().catch(() => {}); return undefined; }
      chunks.push(value);
    }
  } catch { return undefined; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Route capability for one listed model, from exactly the parsing each adapter applies to its catalog. */
function listedCapability(route: HostAuthRoute, model: ListedModel, codex: ReadonlyMap<string, ModelCapability>): ModelCapability {
  // Codex evidence comes from the adapter's own raw-row parser; a row it does not read carries no levels.
  if (route === "codex") return codex.get(model.id) ?? { id: model.id, authRoute: "codex", supportedThinking: [] };
  return xaiModelCapabilities([model], "grok")[0]!;
}

/** A bounded account catalog or safe route failure, with no credential or provider-body payloads. */
export type HostRouteModels =
  | { readonly status: "listed"; readonly route: HostAuthRoute; readonly models: HostModelChoice[]; readonly containsNoSecrets: true }
  | { readonly status: Exclude<HostAuthStatusCode, "configured-unverified">; readonly route: HostAuthRoute; readonly nextAction: string; readonly containsNoSecrets: true };

/** List at most 64 selectable account models without inference, credential renewal or credential writes. */
export async function listRouteModels(selection: Omit<HostAuthSelection, "model">): Promise<HostRouteModels> {
  if (typeof selection !== "object" || selection === null || "model" in selection) throw new Error("invalid");
  const valid = validateAuthSelection({ ...selection, model: "catalog" });
  const failure = (status: Exclude<HostAuthStatusCode, "configured-unverified">, nextAction: string): HostRouteModels =>
    ({ status, route: valid.route, nextAction, containsNoSecrets: true });
  const store = effectiveStore(valid);
  // The owner is fixed when the store is read: a logout during listing must not adopt this catalog for the next account.
  const owner = credentialOwner(valid);
  let refreshBlocked = false, guardRefused = false;
  const refuseRefresh = async (): Promise<never> => {
    refreshBlocked = true;
    try { await valid.credentialWriteGuard?.(credentialReferenceForRoute(valid.route)); }
    catch { guardRefused = true; }
    throw credentialWriteRefusedError();
  };
  // Catalog operations have their own read-only lifecycle, so they cannot join
  // an execution refresh that would persist tokens through the original store.
  const readOnlyStore = { get: store.get.bind(store), set: refuseRefresh, delete: refuseRefresh };
  const ready = await checkAuthReadiness({ route: valid.route, model: valid.model, store: readOnlyStore });
  if (ready.status !== "configured-unverified") return failure(ready.status, ready.nextAction);
  const { discoverModels } = await import("../model/catalog-discovery.ts");
  let listed: readonly ListedModel[] = [];
  let codexCatalog: Uint8Array | undefined;
  const result = await discoverModels({
    provider: valid.route === "codex" ? "openai" : "xai",
    ...(valid.route === "codex" ? { openaiAuth: "codex" as const } : { xaiAuth: "grok" as const }),
    env: valid.env ?? {},
  }, {
    store: readOnlyStore,
    onListed: models => { listed = models; },
    fetch: async (url, init) => {
      // Refuse renewal before HTTP: even an unpersisted rotating refresh token
      // could invalidate the saved login. Only catalog GETs reach the transport.
      if (init?.method !== "GET") return refuseRefresh();
      const response = await (valid.fetch ?? fetch)(url, init);
      if (valid.route !== "codex") return response;
      // Keep the exact catalog bytes so Codex evidence is parsed the way the adapter parses them.
      codexCatalog = await catalogBytes(response);
      return response;
    },
  });
  if (refreshBlocked) {
    if (guardRefused) return failure("store-unavailable", "The embedding application's credential fence refused renewal. Retry listing after the fence allows the normal route to renew credentials.");
    return failure("needs-login", "Renew the route credential, which sends no inference, or sign in again. Then retry listing models. Catalog requests never renew or write credentials.");
  }
  if (result.error) {
    if (/invalid JSON|invalid model list|Could not read|exceeds|timed out|Could not reach/i.test(result.error)) {
      return failure("integration-unavailable", "Could not read the subscription model catalog. Retry listing models later.");
    }
    const classified = classifyAuthError(new Error(result.error), valid);
    return failure(classified.status === "configured-unverified" ? "integration-unavailable" : classified.status,
      classified.status === "model-unavailable" ? "No selectable models were returned for this subscription. Retry listing models or sign in again." : classified.nextAction);
  }
  const models = result.catalog.models.filter(model => {
    try { validateAuthSelection({ route: valid.route, model: model.id }); return true; }
    catch { return false; }
  });
  if (!models.length) return failure("model-unavailable", "No selectable models were returned for this subscription. Retry listing models or sign in again.");
  const { recommendedListedModel } = await import("../model/model-list.ts");
  const recommended = recommendedListedModel(valid.route, models);
  // Keep the shared recommendation even when it lies beyond the 64-row bound.
  const bounded = [models.find(model => model.id === recommended)!, ...models.filter(model => model.id !== recommended)].slice(0, 64);
  // A fresh array of frozen choices: callers may sort or filter the list, never edit a choice.
  const codex = new Map<string, ModelCapability>();
  if (valid.route === "codex" && codexCatalog) {
    const { codexCatalogCapabilities } = await import("../model/providers/codex-subscription.ts");
    try { for (const capability of codexCatalogCapabilities(JSON.parse(new TextDecoder().decode(codexCatalog)))) codex.set(capability.id, capability); }
    catch { /* An unreadable catalog leaves every listed Codex model without levels. */ }
  }
  return { status: "listed", route: valid.route, containsNoSecrets: true, models: bounded.map(model => {
    const source = listed.find(entry => entry.id === model.id) ?? { id: model.id };
    const capability = listedCapability(valid.route, source, codex);
    const choice: HostModelChoice = Object.freeze({
      id: model.id, recommended: model.id === recommended,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      effort: effortSupport(valid.route, model.id, capability),
      outputCap: outputCapSupport(valid.route, model.id),
    });
    // Only a choice Schway listed can widen a route model; the capability stays private.
    registerCatalogEvidence(choice, valid.route, owner, capability);
    return choice;
  }) };
}
