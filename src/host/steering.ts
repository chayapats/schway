import type { LoopSteering } from "../agent/loop.ts";
import type { HostEntryReference, HostProgressEvent } from "./index.ts";

/** Versioned contract for steering an admitted run with follow-up owner input, independent of the composed release version. */
export const STEERING_CONTRACT = "schway.host.steering/v1" as const;

/** Most steers one admitted run accepts, applied or not; later ones are rejected with `limit`. */
export const MAX_STEERS_PER_RUN = 32;

/** Caller-chosen steer identity: 1–128 characters, starting with a letter or digit. */
const STEER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Follow-up owner text for the admitted run, with an application-chosen identity used for idempotency and reporting. */
export interface HostSteerInput {
  /** 1–128 characters from `[A-Za-z0-9._:-]`, starting with a letter or digit; unique within one run. */
  readonly id: string;
  /** Non-blank owner text within `limits.maxInputChars`, with the same trust as submitted input. */
  readonly text: string;
}

/**
 * Synchronous steering verdict. `queued`: accepted and waiting (a repeat while it waits returns it again). `applied`: a repeat
 * of a steer this run already committed. `idle`: no run is admitted, so submit an ordinary turn. `rejected`: not accepted, or
 * a repeat of the steer whose append failed (`uncertain`).
 */
export type HostSteerResult =
  | { readonly kind: "queued"; readonly id: string }
  | { readonly kind: "applied"; readonly id: string; readonly entry: HostEntryReference }
  | { readonly kind: "idle" }
  | { readonly kind: "rejected"; readonly id: string; readonly reason: "id-conflict" | "limit" | "uncertain" };

/** One steer committed as a durable user entry during the run. */
export interface HostAppliedSteer {
  /** The application's steer id. */
  readonly id: string;
  /** The committed native user entry carrying the steer text. */
  readonly entry: HostEntryReference;
}

/** One steer identified by its application id. */
export interface HostSteerIdentity {
  readonly id: string;
}

/**
 * Exact steering disposition of one admitted run, each list in acceptance order. `unapplied` steers were never appended:
 * resubmit each exactly once. `uncertain` holds at most one steer whose append failed after it may have reached storage.
 */
export interface HostSteeringReport {
  /** Steers committed as durable user entries, each before a later model request of this run. */
  readonly applied: readonly HostAppliedSteer[];
  /** Accepted steers never appended; the application resubmits each exactly once. */
  readonly unapplied: readonly HostSteerIdentity[];
  /** At most one steer whose append failed after it may have reached storage; reconcile before resubmitting. */
  readonly uncertain: readonly HostSteerIdentity[];
}

/** One accepted steer and its disposition so far. */
interface SteerRecord { readonly id: string; readonly text: string; entryId?: string; uncertain?: boolean }

/** Steering window open from input acceptance until the run settles. */
export interface SteeringWindow {
  /** Accept, deduplicate or reject one validated steer. */
  accept(input: HostSteerInput): HostSteerResult;
  /** Loop source that reports each application through `report`. */
  source(report: (event: HostProgressEvent) => void): LoopSteering;
  /** Freeze the disposition of every accepted steer. */
  settle(): HostSteeringReport;
}

const IDLE: HostSteerResult = Object.freeze({ kind: "idle" });

/** Steering verdict for a handle with no admitted run. */
export function idleSteer(): HostSteerResult { return IDLE; }

/** True when the steer has only `id` and `text`, a valid id and non-blank text within the host's input bound. */
export function validSteerInput(input: unknown, maxInputChars: number): input is HostSteerInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "id" && key !== "text")) return false;
  return typeof value.id === "string" && STEER_ID.test(value.id) &&
    typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= maxInputChars;
}

/** Open one run's steering window; `ref` turns a committed entry id into a host reference. */
export function openSteeringWindow(ref: (entryId: string) => HostEntryReference): SteeringWindow {
  const accepted = new Map<string, SteerRecord>();
  const pending: SteerRecord[] = [];
  let report: (event: HostProgressEvent) => void = () => undefined;
  let settled = false;
  const head = (id: string): SteerRecord | undefined => pending[0]?.id === id ? pending.shift() : undefined;
  return {
    accept(input) {
      if (settled) return IDLE;
      const id = input.id, existing = accepted.get(id);
      if (existing) {
        if (existing.text !== input.text) return Object.freeze({ kind: "rejected", id, reason: "id-conflict" });
        if (existing.entryId !== undefined) return Object.freeze({ kind: "applied", id, entry: ref(existing.entryId) });
        if (existing.uncertain) return Object.freeze({ kind: "rejected", id, reason: "uncertain" });
        return Object.freeze({ kind: "queued", id });
      }
      if (accepted.size >= MAX_STEERS_PER_RUN) return Object.freeze({ kind: "rejected", id, reason: "limit" });
      const steer: SteerRecord = { id, text: input.text };
      accepted.set(id, steer);
      pending.push(steer);
      return Object.freeze({ kind: "queued", id });
    },
    source(observer) {
      report = observer;
      return {
        next: () => pending[0] ? { id: pending[0].id, text: pending[0].text } : undefined,
        applied(id, entryId) {
          const steer = head(id);
          if (!steer) return;
          steer.entryId = entryId;
          report({ type: "steer_applied", id, entry: ref(entryId), transient: true });
        },
        failed(id) {
          const steer = head(id);
          if (steer) steer.uncertain = true;
        },
      };
    },
    settle() {
      settled = true;
      const all = [...accepted.values()];
      return Object.freeze({
        applied: Object.freeze(all.filter(steer => steer.entryId !== undefined).map(steer => Object.freeze({ id: steer.id, entry: ref(steer.entryId!) }))),
        unapplied: Object.freeze(pending.map(steer => Object.freeze({ id: steer.id }))),
        uncertain: Object.freeze(all.filter(steer => steer.uncertain).map(steer => Object.freeze({ id: steer.id }))),
      });
    },
  };
}
