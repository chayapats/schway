import { lookupModel, type ModelCapability } from "../model/catalog.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../model/model.ts";
import { resolveThinkingPolicy, validateThinking } from "../model/thinking.ts";
import type { HostAuthRoute } from "./auth-routes.ts";
import { HostError } from "./index.ts";

/** Exact reasoning-effort support for one route and model, from the same policy and evidence the adapter enforces. */
export interface HostEffortSupport {
  /** Levels the adapter accepts for this model; empty without account catalog evidence. */
  readonly levels: readonly ThinkingLevel[];
  /** True when `off` sends the provider's disable control; false means `off` sends no control and the provider default applies. */
  readonly offSendable: boolean;
  /** Provider-advertised default when Schway sends no control; null when the evidence names none. */
  readonly default: ThinkingLevel | null;
  /** `account-catalog` for a listed model; `none` for a static description, where no explicit level is accepted. */
  readonly evidence: "account-catalog" | "none";
}

/** Whether a route sends a provider-enforced output cap; caps bound output, never money, and subscription spend stays unknown. */
export interface HostOutputCapSupport {
  /** True when every request carries a cap the provider enforces; false when the endpoint accepts no cap. */
  readonly enforced: boolean;
  /** Cap sent when the embedder sets none; null when no cap is sent. */
  readonly default: number | null;
  /** Largest cap the embedder may set, from Schway's model catalog; null when no cap is sent. */
  readonly maximum: number | null;
}

/** Static output-cap support for a route and model, with no network: Codex rejects caps, Grok sends one. @internal */
export function outputCapSupport(route: HostAuthRoute, model: string): HostOutputCapSupport {
  // The subscription Codex endpoint rejects output caps, so its adapter never sends one.
  if (route === "codex") return Object.freeze({ enforced: false, default: null, maximum: null });
  const limit = lookupModel("xai", model).maxOutput;
  return Object.freeze({ enforced: true, default: limit, maximum: limit });
}

/** Cap every body must carry, or reject `invalid-input` when the route sends none or the value exceeds its maximum. @internal */
export function routeOutputCap(route: HostAuthRoute, model: string, maxOutputTokens: number | undefined, requireOutputCap: boolean): { readonly exact?: number; readonly required: boolean } | undefined {
  if (maxOutputTokens === undefined && !requireOutputCap) return undefined;
  const support = outputCapSupport(route, model);
  if (!support.enforced || (maxOutputTokens !== undefined && maxOutputTokens > support.maximum!)) throw new HostError("invalid-input");
  return Object.freeze({ ...(maxOutputTokens !== undefined ? { exact: maxOutputTokens } : {}), required: true });
}

/** Pin one reasoning effort for every call; `exact` refuses any call that cannot send exactly that effort. */
export interface HostEffortPin {
  /** Level every call sends; `off` only where it sends the provider's disable control. */
  readonly level: ThinkingLevel;
  /** `exact` refuses any call whose body would not carry exactly this level's control. */
  readonly mode: "exact";
}

const evidence = new WeakMap<object, { readonly route: HostAuthRoute; readonly capability: ModelCapability }>();

/** Remember the account capability behind one listed choice, so only Schway-issued evidence widens a model. @internal */
export function registerCatalogEvidence(choice: object, route: HostAuthRoute, capability: ModelCapability): void {
  evidence.set(choice, { route, capability: structuredClone(capability) });
}

/** Return the capability behind a listed choice for exactly this route and model; anything else rejects `invalid-input`. @internal */
export function catalogCapability(choice: unknown, route: HostAuthRoute, model: string): ModelCapability {
  const found = typeof choice === "object" && choice !== null ? evidence.get(choice) : undefined;
  if (!found || found.route !== route || found.capability.id !== model) throw new HostError("invalid-input");
  return structuredClone(found.capability);
}

function providerFor(route: HostAuthRoute): "openai" | "xai" {
  return route === "codex" ? "openai" : "xai";
}

/** Effort support from the adapter's policy for this route, model and evidence; null evidence is the static description. @internal */
export function effortSupport(route: HostAuthRoute, model: string, capability: ModelCapability | null): HostEffortSupport {
  const provider = providerFor(route);
  const policy = resolveThinkingPolicy({ provider, model, authRoute: route, capability });
  const levels = THINKING_LEVELS.filter(level => policy.supported.includes(level) &&
    !validateThinking(provider, model, level, undefined, capability, undefined, route));
  return Object.freeze({ levels: Object.freeze(levels), offSendable: levels.includes("off") && policy.supportsDisabling,
    default: policy.defaultThinking ?? null, evidence: capability ? "account-catalog" as const : "none" as const });
}

/** Wire value an exact pin must find in every request body, or reject `invalid-input` when the adapter would drop or refuse it. @internal */
export function exactEffort(route: HostAuthRoute, model: string, capability: ModelCapability | null, pin: HostEffortPin): { readonly level: ThinkingLevel; readonly sent: string } {
  const support = effortSupport(route, model, capability);
  if (!support.levels.includes(pin.level) || (pin.level === "off" && !support.offSendable)) throw new HostError("invalid-input");
  // Both adapters send `none` for a disabling off and the level name otherwise.
  return Object.freeze({ level: pin.level, sent: pin.level === "off" ? "none" : pin.level });
}
