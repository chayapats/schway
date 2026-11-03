import type { ModelCallOptions } from "./model.ts";

/** Physical inference send kind: the first send of a model call, or the resend after an auth rejection and renewal. */
export type ProviderSendKind = "initial" | "auth-retry";

/**
 * Schway-internal per-stream hooks an adapter calls around physical provider requests.
 * Adapters call `send` synchronously, after every await that precedes the request and
 * immediately before handing the exact body to transport; a throw refuses the send.
 * @internal Travels beside `ModelCallOptions` under a private symbol; never public API.
 */
export interface ProviderDispatch {
  /** Authorize and record one inference send with the exact controls its body carries; throws a refusal when it must not leave. */
  send(kind: ProviderSendKind, body: unknown, controls: ProviderSendControls): void;
  /** Record one credential renewal request this stream's caller started. */
  renewal(): void;
  /** Record the effort a terminal provider response states it applied; null when the response names none. */
  reported(applied: { readonly effort: string | null }): void;
}

/** Exact effort and output-cap controls one request body carries; null where the body carries none. @internal */
export interface ProviderSendControls {
  readonly effort: string | null;
  readonly outputCap: number | null;
}

/** Read the controls from the Responses body object about to be serialized, never from a separate guess. @internal */
export function sentControls(body: Record<string, unknown>): ProviderSendControls {
  const reasoning = body["reasoning"];
  const effort = typeof reasoning === "object" && reasoning !== null ? (reasoning as { effort?: unknown }).effort : undefined;
  const cap = body["max_output_tokens"];
  return { effort: typeof effort === "string" ? effort : null, outputCap: typeof cap === "number" && Number.isSafeInteger(cap) ? cap : null };
}

/** Effort a terminal Responses object states it applied; null when it names none, never inferred from the request. @internal */
export function reportedEffort(response: unknown): string | null {
  const reasoning = typeof response === "object" && response !== null ? (response as { reasoning?: unknown }).reasoning : undefined;
  const effort = typeof reasoning === "object" && reasoning !== null ? (reasoning as { effort?: unknown }).effort : undefined;
  return typeof effort === "string" ? effort : null;
}

const PROVIDER_DISPATCH = Symbol("schway.providerDispatch");
type DispatchCall = ModelCallOptions & { readonly [PROVIDER_DISPATCH]?: ProviderDispatch };

/** Return this stream's dispatch hooks, or undefined when the caller attached none. @internal */
export function providerDispatch(call: ModelCallOptions | undefined): ProviderDispatch | undefined {
  return (call as DispatchCall | undefined)?.[PROVIDER_DISPATCH];
}

/** Copy call options with this stream's dispatch hooks attached; the original object is unchanged. @internal */
export function withProviderDispatch(call: ModelCallOptions | undefined, dispatch: ProviderDispatch): ModelCallOptions {
  return { ...call, [PROVIDER_DISPATCH]: dispatch } as DispatchCall;
}

/** Wrap a renewal transport so each physical request it starts is recorded first. @internal */
export function countingRenewalFetch<F extends (input: string | URL | Request, init?: RequestInit) => Promise<Response>>(fetchFn: F | undefined, onRenewal: (() => void) | undefined): F | undefined {
  if (!onRenewal) return fetchFn;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    onRenewal();
    return (fetchFn ?? fetch)(input, init);
  }) as F;
}

/** Stable, credential-free text of a dispatch refusal; it describes only the refused request. */
export const DISPATCH_REFUSED_MESSAGE = "Provider request refused by the embedding application's dispatch authorizer. The refused request was not sent.";

// Identity, not text: a provider error that echoes the refusal wording must stay an ordinary, retryable failure.
const refusals = new WeakSet<Error>();

/** Credential-free refusal for a send the embedding application vetoed; the authorizer's error is kept as its cause. */
export function dispatchRefusedError(cause?: unknown): Error {
  const error = new Error(DISPATCH_REFUSED_MESSAGE, cause === undefined ? undefined : { cause });
  refusals.add(error);
  return error;
}

/** True only for the refusal error object Schway threw, not its `cause` wrappers; a copied message or a look-alike error never matches. */
export function isDispatchRefused(error: unknown): error is Error {
  return error instanceof Error && refusals.has(error);
}

/** Up to six errors from `error` along its `cause` links, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error, depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    chain.push(current);
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

// Schway's refusals of calls whose pinned effort or required output cap it could not send exactly.
const controlRefusals = new WeakSet<Error>();

/** Credential-free refusal of one call whose pinned effort or required output cap could not be sent exactly. @internal */
export function routeControlRefusedError(message: string): Error {
  const error = new Error(message);
  controlRefusals.add(error);
  return error;
}

/** True only for a route-control refusal error object Schway threw, not its `cause` wrappers; text never matches. */
export function isRouteControlRefused(error: unknown): error is Error {
  return error instanceof Error && controlRefusals.has(error);
}

/** True when the error or an error it wraps as `cause` is a dispatch or route-control refusal; neither is ever retried. @internal */
export function hasPolicyRefusal(error: unknown): boolean {
  return causeChain(error).some(item => isDispatchRefused(item) || isRouteControlRefused(item));
}

/** True when the error or an error it wraps as `cause` is a refusal Schway threw; text never matches. @internal */
export function hasDispatchRefusal(error: unknown): boolean {
  return causeChain(error).some(isDispatchRefused);
}

/** True only for a status-less transport failure whose chain carries Bun's `UnexpectedRedirect` code; response text never matches. @internal */
export function isRefusedRedirect(error: unknown): boolean {
  const chain = causeChain(error).filter((item): item is object => typeof item === "object" && item !== null);
  // An HTTP response error carries body text and a status; it is an answer to keep classifying, not a refused redirect.
  if (chain.some(item => typeof (item as { status?: unknown }).status === "number")) return false;
  return chain.some(item => (item as { code?: unknown }).code === "UnexpectedRedirect");
}

// Schway's own refused-redirect errors, so classification never trusts text a provider could echo.
const redirects = new WeakSet<Error>();

/** Create one of Schway's own refused-redirect failures, recognized later by identity only. @internal */
export function redirectRefusal(message: string): Error {
  const error = new Error(message);
  redirects.add(error);
  return error;
}

/** True when the error or an error it wraps as `cause` is a refused-redirect failure Schway created. @internal */
export function hasRedirectRefusal(error: unknown): boolean {
  return causeChain(error).some(item => item instanceof Error && redirects.has(item));
}

/** Sanitized, non-transient failure for a route send whose endpoint answered with a redirect; no URL or transport text. @internal */
export function redirectRefusedError(label: string): Error {
  return redirectRefusal(`The ${label} answered with an HTTP redirect. Route requests never follow redirects, so the request was not resent. Retry later.`);
}
