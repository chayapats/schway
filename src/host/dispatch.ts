import { createHash } from "node:crypto";
import type { Model, ModelCallOptions } from "../model/model.ts";
import { dispatchRefusedError, hasRedirectRefusal, withProviderDispatch, type ProviderDispatch } from "../model/dispatch.ts";
import type { HostAuthRoute } from "./auth-routes.ts";
import type { HostProviderRequests } from "./index.ts";
import { HostError } from "./index.ts";

export { isDispatchRefused } from "../model/dispatch.ts";

/** Credential-free description of one physical inference request Schway is about to send on a route. */
export interface HostDispatch {
  /** Selected subscription route; it never changes within a run. */
  readonly route: HostAuthRoute;
  /** Adapter provider label, `codex-subscription` or `xai`. */
  readonly provider: string;
  /** Exact model id the request names. */
  readonly model: string;
  /** `initial` for a model call's first send; `auth-retry` for its resend after an auth rejection and renewal. */
  readonly kind: "initial" | "auth-retry";
  /** 1-based position of this send within one model stream. */
  readonly sequence: number;
  /** Lowercase hex SHA-256 of the exact request body bytes; bodies never carry credentials. */
  readonly bodySha256: string;
  /** Byte length of the exact request body. */
  readonly bodyBytes: number;
}

/**
 * Synchronous embedding-application veto, called immediately before each physical inference send
 * with no await before the request starts. Throwing refuses that send; so does returning a promise,
 * which is never awaited. A refused send never leaves the process and is never retried.
 */
export type HostDispatchAuthorizer = (dispatch: HostDispatch) => void;

/** Options for a route-bound model; omitting them keeps behavior and request bytes unchanged. */
export interface HostRouteModelOptions {
  /** Authorize every physical inference send this model makes, including auth-retry resends. */
  readonly authorizeDispatch?: HostDispatchAuthorizer;
}

/** Validate route-model options without reading credentials or loading an adapter. @internal */
export function routeModelOptions(input: unknown): HostRouteModelOptions {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).some(key => key !== "authorizeDispatch")) throw new HostError("invalid-input");
  const authorize = (input as { authorizeDispatch?: unknown }).authorizeDispatch;
  if (authorize !== undefined && typeof authorize !== "function") throw new HostError("invalid-input");
  return authorize === undefined ? {} : { authorizeDispatch: authorize as HostDispatchAuthorizer };
}

type RunState = { initialSends: number; authRetrySends: number; renewalRequests: number; unobserved: boolean; lastSendRefused: boolean; lastRedirectRefused: boolean };
type CallMeter = { attached: boolean; readonly state: RunState };
const RUN_METER = Symbol("schway.host.runMeter");
type MeteredCall = ModelCallOptions & { readonly [RUN_METER]?: CallMeter };

/** Provider-request accounting for one admitted run. @internal */
export interface RunMeter {
  /** Attach this run to one model call; settle marks the run unobserved when no route model saw the call. */
  begin(call: ModelCallOptions | undefined): { readonly call: ModelCallOptions; settle(): void };
  /** Frozen exact counts, or null when any model call bypassed a Schway route model. */
  snapshot(): HostProviderRequests | null;
  /** True when the most recent model call ended on a refused dispatch; each new call clears it. */
  readonly lastSendRefused: boolean;
  /** True when the most recent model call ended on one of Schway's refused redirects; each new call clears it. */
  readonly lastRedirectRefused: boolean;
}

/** Start exact accounting for one run; zero model calls report zero requests. @internal */
export function createRunMeter(): RunMeter {
  const state: RunState = { initialSends: 0, authRetrySends: 0, renewalRequests: 0, unobserved: false, lastSendRefused: false, lastRedirectRefused: false };
  return {
    begin(call) {
      // A refusal belongs to its own call: a later call that fails before sending reports its own failure.
      state.lastSendRefused = false;
      state.lastRedirectRefused = false;
      const meter: CallMeter = { attached: false, state };
      return { call: { ...call, [RUN_METER]: meter } as MeteredCall, settle() { if (!meter.attached) state.unobserved = true; } };
    },
    snapshot() {
      return state.unobserved ? null : Object.freeze({ initialSends: state.initialSends, authRetrySends: state.authRetrySends, renewalRequests: state.renewalRequests });
    },
    get lastSendRefused() { return state.lastSendRefused; },
    get lastRedirectRefused() { return state.lastRedirectRefused; },
  };
}

function exactBytes(body: unknown): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Without exact bytes the authorizer cannot judge the send, so it fails closed.
  throw new Error("Request body bytes are not inspectable.");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  try { return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function"; }
  catch { return true; }
}

/** Wrap the selected route stack so each physical send is authorized and counted for the calling run. @internal */
export function dispatchRouteModel(model: Model, route: HostAuthRoute, authorize: HostDispatchAuthorizer | undefined): Model {
  const provider = model.provider, id = model.id, stream = model.stream.bind(model);
  return Object.freeze({ provider, id, async *stream(request, call) {
    const meter = (call as MeteredCall | undefined)?.[RUN_METER];
    if (meter) meter.attached = true;
    let sequence = 0;
    const refuse = (cause?: unknown): never => {
      if (meter) meter.state.lastSendRefused = true;
      throw dispatchRefusedError(cause);
    };
    const hooks: ProviderDispatch = {
      send(kind, body) {
        sequence += 1;
        if (authorize) {
          let verdict: unknown;
          try {
            const bytes = exactBytes(body);
            verdict = authorize(Object.freeze({ route, provider, model: id, kind, sequence,
              bodySha256: createHash("sha256").update(bytes).digest("hex"), bodyBytes: bytes.byteLength }));
          } catch (error) { refuse(error); }
          if (isThenable(verdict)) {
            try { (verdict as PromiseLike<unknown>).then(undefined, () => {}); } catch { /* Refused either way. */ }
            refuse();
          }
        }
        if (!meter) return;
        meter.state.lastSendRefused = false;
        if (kind === "initial") meter.state.initialSends++;
        else meter.state.authRetrySends++;
      },
      renewal() { if (meter) meter.state.renewalRequests++; },
    };
    // The loop keeps only the message, so the run learns of Schway's own redirect failures here, by identity.
    try { yield* stream(request, withProviderDispatch(call, hooks)); }
    catch (error) { if (meter && hasRedirectRefusal(error)) meter.state.lastRedirectRefused = true; throw error; }
  } } as Model);
}
