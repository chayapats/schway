import { createNativeCredentialStore, credentialWriteRefusedError, isCleanupUncertain, markCleanupUncertain, type CredentialStore } from "../auth/store.ts";
import type { Model } from "../model/model.ts";
import type { HostAuthRoute, HostCredentialStore, HostCredentialWriteGuard } from "./auth-routes.ts";
import { credentialReferenceForRoute } from "./auth-routes.ts";
import { HostError } from "./index.ts";

/** Shared process-local native credential ownership without credential access on the returned handle. */
export interface HostCredentialLifecycle {
  /** Fence existing route work before deleting its credential; other routes remain independent. */
  logout(route: HostAuthRoute): Promise<void>;
  /** Dispose this idle owner without logging out; active streams refuse with busy. */
  close(): Promise<void>;
}

/** Optional secure-store seam for isolated deterministic embeddings; omission selects Schway's OS store. */
export interface HostCredentialLifecycleOptions { readonly store?: HostCredentialStore }

type Interest = { owner: Owner; controller: AbortController; guard?: HostCredentialWriteGuard; refused: boolean };
type Route = { epoch: number; store: CredentialStore; interests: Set<Interest>; writes: Promise<void>; uncertain?: boolean };
type State = { base: CredentialStore; routes: Map<HostAuthRoute, Route> };
type Owner = { state: State; closed: boolean; active: number };
const owners = new WeakMap<HostCredentialLifecycle, Owner>();
const states = new WeakMap<HostCredentialStore, State>();
let native: CredentialStore | undefined;

function ownerFor(handle: HostCredentialLifecycle): Owner {
  const owner = owners.get(handle);
  if (!owner) throw new HostError("invalid-options");
  if (owner.closed) throw new HostError("closed");
  return owner;
}

function serialized<T>(route: Route, operation: () => Promise<T>): Promise<T> {
  const pending = route.writes.then(operation);
  route.writes = pending.then(() => {}, () => {});
  return pending;
}

function routeFor(state: State, name: HostAuthRoute): Route {
  let route = state.routes.get(name);
  if (!route) {
    route = { epoch: 0, store: undefined!, interests: new Set(), writes: Promise.resolve() };
    state.routes.set(name, route);
    route.store = routeStore(state, route, name);
  }
  return route;
}

function routeStore(state: State, route: Route, name: HostAuthRoute): CredentialStore {
  const epoch = route.epoch, identity = Object.freeze(credentialReferenceForRoute(name));
  const current = () => { if (epoch !== route.epoch) throw credentialWriteRefusedError(); };
  const authorize = async () => {
    current();
    const allowed = await Promise.all([...route.interests].map(async interest => {
      if (interest.owner.closed || interest.controller.signal.aborted) return false;
      try { await interest.guard?.(identity); }
      catch { interest.refused = true; return false; }
      return !interest.controller.signal.aborted && !interest.owner.closed;
    }));
    current();
    if (!allowed.some(Boolean)) throw credentialWriteRefusedError();
    // Refused peers must detach before a valid peer can use the shared renewal.
    // When all peers refuse, let the write/cleanup error reach every waiter first.
    for (const interest of route.interests) if (interest.refused) interest.controller.abort();
  };
  return {
    async get(requested) {
      current();
      if (requested.account !== identity.account) throw new HostError("invalid-options");
      await route.writes;
      current();
      if (route.uncertain) throw new HostError("storage");
      return state.base.get(identity);
    },
    set(requested, value) {
      if (requested.account !== identity.account) return Promise.reject(new HostError("invalid-options"));
      const writers = new Set([...route.interests].map(interest => interest.owner));
      for (const owner of writers) owner.active++;
      return serialized(route, async () => {
        await authorize();
        try {
          await state.base.set(identity, value);
          await authorize();
        } catch (error) {
          // A backend can commit then reject. Remove only this write, under the route chain.
          try {
            if (state.base.compareAndDelete) await state.base.compareAndDelete(identity, value);
            else if (await state.base.get(identity) === value) await state.base.delete(identity);
          } catch {
            route.uncertain = true;
            const refused = credentialWriteRefusedError();
            refused.message = "Credential store write refused by the embedding-application fence. Credential cleanup could not be verified.";
            throw markCleanupUncertain(refused, new HostError("storage"));
          }
          throw error;
        }
      }).finally(() => { for (const owner of writers) owner.active--; });
    },
    async delete() { throw new HostError("invalid-options"); },
  };
}

/** Create an opaque owner sharing renewal by secure-store identity and route across distinct hosts. */
export function createHostCredentialLifecycle(options: HostCredentialLifecycleOptions = {}): HostCredentialLifecycle {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "store") ||
      (options.store !== undefined && (!options.store || typeof options.store.get !== "function" ||
        typeof options.store.set !== "function" || typeof options.store.delete !== "function"))) throw new HostError("invalid-options");
  const base = options.store ?? (native ??= createNativeCredentialStore());
  let state = states.get(base);
  if (!state) { state = { base, routes: new Map() }; states.set(base, state); }
  const owner: Owner = { state, closed: false, active: 0 };
  const handle: HostCredentialLifecycle = Object.freeze({
    async logout(name: HostAuthRoute) {
      ownerFor(handle);
      if (name !== "codex" && name !== "grok") throw new HostError("invalid-options");
      const route = routeFor(owner.state, name);
      // Rotate store identity synchronously: old provider refreshers can never write in the new epoch.
      route.epoch++;
      route.uncertain = true;
      route.store = routeStore(owner.state, route, name);
      for (const interest of route.interests) { interest.refused = true; interest.controller.abort(); }
      owner.active++;
      try { await serialized(route, async () => { await owner.state.base.delete(credentialReferenceForRoute(name)); route.uncertain = false; }); }
      catch { throw new HostError("storage"); }
      finally { owner.active--; }
    },
    async close() {
      if (owner.closed) return;
      if (owner.active) throw new HostError("busy");
      owner.closed = true;
    },
  });
  owners.set(handle, owner);
  return handle;
}

/** Validate the opaque owner without reading credentials or loading an adapter. @internal */
export function validateCredentialLifecycle(handle: HostCredentialLifecycle): void { ownerFor(handle); }

/** Pin the owner through an admitted route operation, including local readiness, tools and retries. @internal */
export function acquireCredentialLifecycle(handle: HostCredentialLifecycle): () => void {
  const owner = ownerFor(handle); owner.active++;
  let released = false;
  return () => { if (!released) { released = true; owner.active--; } };
}

/** Resolve the current shared route store without publishing it on the lifecycle handle. @internal */
export function credentialLifecycleStore(handle: HostCredentialLifecycle, name: HostAuthRoute): CredentialStore {
  return routeFor(ownerFor(handle).state, name).store;
}

/** Attach one stream's cancellation and write fence without changing its siblings' authority. @internal */
export function lifecycleModel(handle: HostCredentialLifecycle, name: HostAuthRoute, store: CredentialStore, model: Model, guard?: HostCredentialWriteGuard): Model {
  return Object.freeze({ provider: model.provider, id: model.id, async *stream(request, call) {
    const owner = ownerFor(handle), route = routeFor(owner.state, name);
    if (route.store !== store) throw credentialWriteRefusedError();
    const controller = new AbortController();
    const interest: Interest = { owner, controller, guard, refused: false };
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    owner.active++; route.interests.add(interest);
    try {
      try { await guard?.(credentialReferenceForRoute(name)); }
      catch { interest.refused = true; throw credentialWriteRefusedError(); }
      controller.signal.throwIfAborted();
      for await (const event of model.stream({ ...request, signal: controller.signal }, call)) yield event;
    } catch (error) {
      if (isCleanupUncertain(error)) throw error;
      if (interest.refused) throw credentialWriteRefusedError();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
      route.interests.delete(interest); owner.active--;
    }
  } } as Model);
}
