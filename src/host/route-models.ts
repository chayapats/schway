import { checkAuthReadiness, classifyAuthError, credentialReferenceForRoute, effectiveStore, validateAuthSelection,
  type HostAuthRoute, type HostAuthSelection, type HostAuthStatusCode } from "./auth-routes.ts";
import { credentialWriteRefusedError } from "../auth/store.ts";

/** One selectable account model with the shared route recommendation and observed context limit. */
export interface HostModelChoice {
  readonly id: string;
  readonly recommended: boolean;
  readonly contextWindow?: number;
}

/** A bounded account catalog or safe route failure, with no credential or provider-body payloads. */
export type HostRouteModels =
  | { readonly status: "listed"; readonly route: HostAuthRoute; readonly models: readonly HostModelChoice[]; readonly containsNoSecrets: true }
  | { readonly status: Exclude<HostAuthStatusCode, "configured-unverified">; readonly route: HostAuthRoute; readonly nextAction: string; readonly containsNoSecrets: true };

/** List at most 64 selectable account models without inference, credential renewal or credential writes. */
export async function listRouteModels(selection: Omit<HostAuthSelection, "model">): Promise<HostRouteModels> {
  if (typeof selection !== "object" || selection === null || "model" in selection) throw new Error("invalid");
  const valid = validateAuthSelection({ ...selection, model: "catalog" });
  const failure = (status: Exclude<HostAuthStatusCode, "configured-unverified">, nextAction: string): HostRouteModels =>
    ({ status, route: valid.route, nextAction, containsNoSecrets: true });
  const store = effectiveStore(valid);
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
  const ready = await checkAuthReadiness({ ...valid, store: readOnlyStore });
  if (ready.status !== "configured-unverified") return failure(ready.status, ready.nextAction);
  const { discoverModels } = await import("../model/catalog-discovery.ts");
  const result = await discoverModels({
    provider: valid.route === "codex" ? "openai" : "xai",
    ...(valid.route === "codex" ? { openaiAuth: "codex" as const } : { xaiAuth: "grok" as const }),
    env: valid.env ?? {},
  }, {
    store: readOnlyStore,
    fetch: async (url, init) => {
      // Refuse renewal before HTTP: even an unpersisted rotating refresh token
      // could invalidate the saved login. Only catalog GETs reach the transport.
      if (init?.method !== "GET") return refuseRefresh();
      return (valid.fetch ?? fetch)(url, init);
    },
  });
  if (refreshBlocked) {
    if (guardRefused) return failure("store-unavailable", "The embedding application's credential fence refused renewal. Retry listing after the fence allows the normal route to renew credentials.");
    return failure("needs-login", "Renew the subscription through sign-in or a normal route-bound request, then retry listing models. Catalog requests never renew or write credentials.");
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
  return { status: "listed", route: valid.route, containsNoSecrets: true, models: bounded.map(model => ({
    id: model.id, recommended: model.id === recommended,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  })) };
}
