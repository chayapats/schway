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

const REFUSED_MESSAGE = "Provider request refused by the embedding application's dispatch authorizer. No request was sent.";

/** Credential-free refusal for a send the embedding application vetoed; the authorizer's error is kept as its cause. */
export function dispatchRefusedError(cause?: unknown): Error {
  const error = new Error(REFUSED_MESSAGE, cause === undefined ? undefined : { cause });
  (error as { code?: unknown }).code = "dispatch-refused";
  return error;
}

/** True when an error is a dispatch-authorizer refusal; brand-first, with a message fallback that survives the loop's plain-message errors. */
export function isDispatchRefused(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === "dispatch-refused") return true;
  return error.message.includes("refused by the embedding application's dispatch authorizer");
}
