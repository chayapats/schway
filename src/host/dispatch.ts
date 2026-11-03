import { createHash } from "node:crypto";
import { THINKING_LEVELS, type Model, type ModelCallOptions, type ThinkingLevel } from "../model/model.ts";
import { dispatchRefusedError, hasRedirectRefusal, routeControlRefusedError, withProviderDispatch, type ProviderDispatch } from "../model/dispatch.ts";
import type { HostAuthRoute } from "./auth-routes.ts";
import type { HostEffortPin } from "./route-capabilities.ts";
import type { HostProviderRequests } from "./index.ts";
import { HostError } from "./index.ts";

export { isDispatchRefused, isRouteControlRefused } from "../model/dispatch.ts";

/** Effort for one send: the level requested and the exact wire control in its body. */
export interface HostDispatchEffort {
  /** Level the call requested after any pin; null when it requested none. */
  readonly requested: ThinkingLevel | null;
  /** Exact `reasoning.effort` value in the body, such as `none` or `high`; null when the body carries no effort control. */
  readonly sent: string | null;
}

/** Output cap one body carries. */
export interface HostDispatchOutputCap {
  /** Exact `max_output_tokens` value in the body; null when the body carries no cap. */
  readonly sent: number | null;
}

/** Effort for one attempt's sends, plus what the provider response stated; metadata, not proof of internal computation. */
export interface HostAttemptEffort extends HostDispatchEffort {
  /** Effort a terminal provider response states it applied; null when it names none, never inferred from `sent`. */
  readonly reported: string | null;
}

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
  /** Effort requested and the exact effort control this body carries. */
  readonly effort: HostDispatchEffort;
  /** Exact output cap this body carries. */
  readonly outputCap: HostDispatchOutputCap;
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
  /** Account evidence for the bound model from `listRouteModels`; the adapter then accepts the listed effort levels. */
  readonly catalogModel?: import("./route-models.ts").HostModelChoice;
  /** Exact effort for every call, compaction and auth-retry included; needs `catalogModel` that lists a sendable level. */
  readonly effort?: HostEffortPin;
  /** Output cap every call sends exactly: a positive safe integer at or below the route's maximum, on a route that sends caps. */
  readonly maxOutputTokens?: number;
  /** Refuse unless every call sends a provider-enforced output cap; rejects `invalid-input` on a route that sends none. */
  readonly requireOutputCap?: boolean;
}

const ROUTE_MODEL_OPTION_KEYS = ["authorizeDispatch", "catalogModel", "effort", "maxOutputTokens", "requireOutputCap"];

/** Validate route-model option shapes without reading credentials or loading an adapter; route evidence is checked later. @internal */
export function routeModelOptions(input: unknown): HostRouteModelOptions {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).some(key => !ROUTE_MODEL_OPTION_KEYS.includes(key))) throw new HostError("invalid-input");
  const { authorizeDispatch, catalogModel, effort, maxOutputTokens, requireOutputCap } = input as Record<string, unknown>;
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) throw new HostError("invalid-input");
  if (requireOutputCap !== undefined && typeof requireOutputCap !== "boolean") throw new HostError("invalid-input");
  if (authorizeDispatch !== undefined && typeof authorizeDispatch !== "function") throw new HostError("invalid-input");
  if (catalogModel !== undefined && (typeof catalogModel !== "object" || catalogModel === null)) throw new HostError("invalid-input");
  if (effort !== undefined) {
    if (typeof effort !== "object" || effort === null || Array.isArray(effort) || Object.keys(effort).some(key => key !== "level" && key !== "mode")) throw new HostError("invalid-input");
    const { level, mode } = effort as Record<string, unknown>;
    if (!THINKING_LEVELS.includes(level as ThinkingLevel) || mode !== "exact") throw new HostError("invalid-input");
  }
  return {
    ...(authorizeDispatch !== undefined ? { authorizeDispatch: authorizeDispatch as HostDispatchAuthorizer } : {}),
    ...(catalogModel !== undefined ? { catalogModel: catalogModel as import("./route-models.ts").HostModelChoice } : {}),
    ...(effort !== undefined ? { effort: Object.freeze({ level: (effort as HostEffortPin).level, mode: "exact" as const }) } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens: maxOutputTokens as number } : {}),
    ...(requireOutputCap !== undefined ? { requireOutputCap: requireOutputCap as boolean } : {}),
  };
}

/** Controls a route model must find in every body it sends; set only from validated options. @internal */
export interface RouteControls {
  /** Pinned level and the exact wire value each body must carry. */
  readonly effort?: { readonly level: ThinkingLevel; readonly sent: string };
  /** A cap each body must carry, exactly `exact` when set. */
  readonly outputCap?: { readonly exact?: number; readonly required: boolean };
}

/** Stable text for a call whose own thinking conflicts with the model's exact pin. */
const EFFORT_CONFLICT = "The request asked for a reasoning effort other than the model's pinned effort, so it was not sent. Leave the request's thinking unset or match the pin.";
/** Stable text for a body that does not carry the pinned effort exactly. */
const EFFORT_NOT_SENT = "The pinned reasoning effort could not be sent exactly, so the request was not sent. Pin a level this model lists.";
/** Stable text for a body that does not carry the required output cap exactly. */
const CAP_NOT_SENT = "The required output cap could not be sent exactly, so the request was not sent. Retry with a cap this route supports.";

type Observation = { effort: { requested: ThinkingLevel | null; sent: string | null; reported: string | null }; outputCap: { sent: number | null } };

type RunState = { initialSends: number; authRetrySends: number; renewalRequests: number; unobserved: boolean; lastSendRefused: boolean; lastRedirectRefused: boolean; lastControlRefusal: Error | null };
type CallMeter = { attached: boolean; observation: Observation | null; readonly state: RunState };
const RUN_METER = Symbol("schway.host.runMeter");
type MeteredCall = ModelCallOptions & { readonly [RUN_METER]?: CallMeter };

/** Provider-request accounting for one admitted run. @internal */
export interface RunMeter {
  /** Attach this run to one model call; settle marks the run unobserved when no route model saw the call. */
  begin(call: ModelCallOptions | undefined): { readonly call: ModelCallOptions; settle(): void; tag(usage: object): void };
  /** Effort and output cap observed for the call whose usage object this is; null when that call sent nothing observable. */
  attempt(usage: object): { readonly effort: HostAttemptEffort | null; readonly outputCap: HostDispatchOutputCap | null };
  /** Frozen exact counts, or null when any model call bypassed a Schway route model. */
  snapshot(): HostProviderRequests | null;
  /** True when the most recent model call ended on a refused dispatch; each new call clears it. */
  readonly lastSendRefused: boolean;
  /** True when the most recent model call ended on one of Schway's refused redirects; each new call clears it. */
  readonly lastRedirectRefused: boolean;
  /** The route-control refusal that ended the most recent model call, or null; each new call clears it. */
  readonly lastControlRefusal: Error | null;
}

/** Start exact accounting for one run; zero model calls report zero requests. @internal */
export function createRunMeter(): RunMeter {
  const state: RunState = { initialSends: 0, authRetrySends: 0, renewalRequests: 0, unobserved: false, lastSendRefused: false, lastRedirectRefused: false, lastControlRefusal: null };
  // Each attempt's usage object is the one its own call yielded, so observations never cross attempts.
  const tagged = new WeakMap<object, CallMeter>();
  return {
    begin(call) {
      // A refusal belongs to its own call: a later call that fails before sending reports its own failure.
      state.lastSendRefused = false;
      state.lastRedirectRefused = false;
      state.lastControlRefusal = null;
      const meter: CallMeter = { attached: false, observation: null, state };
      return { call: { ...call, [RUN_METER]: meter } as MeteredCall, settle() { if (!meter.attached) state.unobserved = true; },
        tag(usage) { tagged.set(usage, meter); } };
    },
    attempt(usage) {
      const observed = tagged.get(usage)?.observation;
      return { effort: observed ? Object.freeze({ ...observed.effort }) : null, outputCap: observed ? Object.freeze({ ...observed.outputCap }) : null };
    },
    snapshot() {
      return state.unobserved ? null : Object.freeze({ initialSends: state.initialSends, authRetrySends: state.authRetrySends, renewalRequests: state.renewalRequests });
    },
    get lastSendRefused() { return state.lastSendRefused; },
    get lastRedirectRefused() { return state.lastRedirectRefused; },
    get lastControlRefusal() { return state.lastControlRefusal; },
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

/** Wrap the selected route stack so each physical send is checked, authorized and counted for the calling run. @internal */
export function dispatchRouteModel(model: Model, route: HostAuthRoute, authorize: HostDispatchAuthorizer | undefined, controls: RouteControls = {}): Model {
  const provider = model.provider, id = model.id, stream = model.stream.bind(model);
  return Object.freeze({ provider, id, async *stream(request, call) {
    const meter = (call as MeteredCall | undefined)?.[RUN_METER];
    if (meter) meter.attached = true;
    // The loop keeps only the message, so the run learns of a route-control refusal here, by identity.
    const refuseControl = (message: string): never => {
      const refusal = routeControlRefusedError(message);
      if (meter) meter.state.lastControlRefusal = refusal;
      throw refusal;
    };
    // An exact pin applies to every call, compaction included; a conflicting request is refused before any I/O.
    if (controls.effort && request.thinking !== undefined && request.thinking !== controls.effort.level) refuseControl(EFFORT_CONFLICT);
    const effective = controls.effort ? { ...request, thinking: controls.effort.level } : request;
    const requested = effective.thinking ?? null;
    let sequence = 0;
    const refuse = (cause?: unknown): never => {
      if (meter) meter.state.lastSendRefused = true;
      throw dispatchRefusedError(cause);
    };
    const hooks: ProviderDispatch = {
      send(kind, body, sent) {
        sequence += 1;
        // Control checks run before the authorizer: a body that cannot honor the pin never reaches it or the network.
        if (controls.effort && sent.effort !== controls.effort.sent) refuseControl(EFFORT_NOT_SENT);
        const cap = controls.outputCap;
        if (cap && (cap.exact !== undefined ? sent.outputCap !== cap.exact : sent.outputCap === null || sent.outputCap < 1)) refuseControl(CAP_NOT_SENT);
        const effort = Object.freeze({ requested, sent: sent.effort });
        const outputCap = Object.freeze({ sent: sent.outputCap });
        if (authorize) {
          let verdict: unknown;
          try {
            const bytes = exactBytes(body);
            verdict = authorize(Object.freeze({ route, provider, model: id, kind, sequence,
              bodySha256: createHash("sha256").update(bytes).digest("hex"), bodyBytes: bytes.byteLength, effort, outputCap }));
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
        // The attempt reports its last send; an auth-retry carries the same controls as its initial send.
        meter.observation = { effort: { requested, sent: sent.effort, reported: meter.observation?.effort.reported ?? null }, outputCap: { sent: sent.outputCap } };
      },
      renewal() { if (meter) meter.state.renewalRequests++; },
      reported(applied) { if (meter?.observation) meter.observation.effort.reported = applied.effort; },
    };
    // The loop keeps only the message, so the run learns of Schway's own redirect failures here, by identity.
    try { yield* stream(effective, withProviderDispatch(call, hooks)); }
    catch (error) { if (meter && hasRedirectRefusal(error)) meter.state.lastRedirectRefused = true; throw error; }
  } } as Model);
}
