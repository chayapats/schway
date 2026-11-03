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
  /** Authorize and record one inference send; throws a dispatch refusal when it must not leave. */
  send(kind: ProviderSendKind, body: unknown): void;
  /** Record one credential renewal request this stream's caller started. */
  renewal(): void;
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

/** True only for the refusal error object Schway threw; a copied message or a look-alike error never matches. */
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

/** True when the error or an error it wraps as `cause` is a refusal Schway threw; text never matches. @internal */
export function hasDispatchRefusal(error: unknown): boolean {
  return causeChain(error).some(isDispatchRefused);
}

/** True when a fetch failed because `redirect: "error"` refused a 3xx answer, as Bun and undici report it. @internal */
export function isRefusedRedirect(error: unknown): boolean {
  return causeChain(error).some(item => typeof item === "object" && item !== null &&
    ((item as { code?: unknown }).code === "UnexpectedRedirect" || (item instanceof Error && /unexpected redirect/i.test(item.message))));
}

/** Sanitized, non-transient failure for a route send whose endpoint answered with a redirect; no URL or transport text. @internal */
export function redirectRefusedError(label: string): Error {
  return new Error(`The ${label} answered with an HTTP redirect. Route requests never follow redirects, so the request was not resent.`);
}
