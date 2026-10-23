import { createHash } from "node:crypto";

/** Supported native-state snapshot contract for quiesced managed sessions. */
export const SNAPSHOT_CONTRACT = "schway.host.session-snapshot/v1" as const;

/** Current native session format understood by this build; mirrors SESSION_FORMAT_VERSION without loading native persistence on the static path. */
export const SNAPSHOT_NATIVE_FORMAT_VERSION = 4;

/** Bound on sessions per snapshot; keeps one coherent capture in memory. */
export const MAX_SNAPSHOT_SESSIONS = 64;

/** Bound on one opaque artifact; production histories stay far below this. */
export const MAX_SNAPSHOT_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** Opaque native artifact kind captured for one managed session. */
export type HostSnapshotArtifactKind = "conversation" | "metadata";

/** One opaque native artifact with integrity metadata; bytes stay base64-encoded. */
export interface HostSnapshotArtifact {
  /** Which owned native file this artifact restores. */
  readonly kind: HostSnapshotArtifactKind;
  /** Decoded byte length of the artifact. */
  readonly size: number;
  /** Hex SHA-256 of the decoded bytes. */
  readonly sha256: string;
  /** Base64-encoded opaque native bytes; never credentials or unowned files. */
  readonly dataBase64: string;
}

/** One captured managed session with stable refs, ancestry and integrity inventory. */
export interface HostSnapshotSession {
  /** Stable native session identity. */
  readonly id: string;
  /** Captured conversation branch ancestry. */
  readonly branchId: string;
  /** Workspace root the artifacts were captured under. */
  readonly workspaceRoot: string;
  /** Header creation time of the captured session. */
  readonly headerCreatedAt: string;
  /** Session format version observed at capture time. */
  readonly nativeFormatVersion: number;
  /** Whether a retirement tombstone existed at capture time. */
  readonly retired: boolean;
  /** Owned conversation/metadata inventory with hashes; leases are never captured. */
  readonly artifacts: readonly HostSnapshotArtifact[];
}

/** Coherent native-state snapshot covering one quiesced managed set. */
export interface HostSessionSnapshot {
  /** Snapshot contract version. */
  readonly snapshotContract: typeof SNAPSHOT_CONTRACT;
  /** Current native format version understood by this build. */
  readonly nativeFormatVersion: number;
  /** ISO creation time of the snapshot. */
  readonly createdAt: string;
  /** Captured sessions in caller order. */
  readonly sessions: readonly HostSnapshotSession[];
}

/** Snapshot options; retired contexts are recorded unless excluded. */
export interface HostSnapshotOptions {
  /** Skip retired sessions instead of recording them with retired true. */
  readonly excludeRetired?: boolean;
}

/** Restore options; retired snapshots stay retired unless excluded. */
export interface HostSnapshotRestoreOptions {
  /** Skip retired snapshot sessions instead of restoring their tombstones. */
  readonly excludeRetired?: boolean;
}

/** Quarantine reason for a snapshot that must not activate. */
export type HostSnapshotQuarantineReason =
  | "missing-artifact"
  | "corrupt"
  | "unsupported-version"
  | "incomplete"
  | "conflict"
  | "workspace-mismatch";

/** Offline validation verdict; quarantined snapshots must not restore or run. */
export type HostSnapshotValidation =
  | { readonly status: "valid"; readonly sessions: readonly import("./index.ts").HostSessionReference[]; readonly nextAction: string }
  | { readonly status: "quarantined"; readonly reason: HostSnapshotQuarantineReason; readonly nextAction: string };

/** Restore verdict; partial never auto-runs model calls or tools. */
export type HostSnapshotRestoreResult =
  | { readonly status: "restored"; readonly sessions: readonly import("./index.ts").HostSessionReference[]; readonly nextAction: string }
  | { readonly status: "quarantined"; readonly reason: HostSnapshotQuarantineReason; readonly nextAction: string }
  | { readonly status: "partial"; readonly restored: readonly import("./index.ts").HostSessionReference[]; readonly remaining: readonly import("./index.ts").HostSessionReference[]; readonly nextAction: string };

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRANCH_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

/** Hex SHA-256 for one opaque artifact. */
export function hashSnapshotBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Sanitized next-action guidance without paths, tokens or provider payloads. */
export function snapshotGuidance(kind: "valid" | "restored" | "quarantined" | "partial", reason?: HostSnapshotQuarantineReason): string {
  if (kind === "restored" || kind === "valid") return "Snapshot restored. Reopen a session to continue.";
  if (kind === "partial") return "Snapshot partly restored. Retry restore after checking session storage permissions.";
  switch (reason) {
    case "unsupported-version":
      return "Snapshot quarantined. Restore with a compatible Schway build.";
    case "workspace-mismatch":
      return "Snapshot quarantined. Restore into the matching workspace store.";
    case "conflict":
      return "Snapshot quarantined. Close the session and retry restore.";
    case "missing-artifact":
      return "Snapshot quarantined. Export the sessions again before restoring.";
    case "corrupt":
      return "Snapshot quarantined. Export the sessions again before restoring.";
    default:
      return "Snapshot quarantined. Export the sessions again before restoring.";
  }
}

/** Validate snapshot shape, hashes and versions without touching any store. */
export function validateSnapshotShape(snapshot: unknown): HostSnapshotValidation {
  const fail = (reason: HostSnapshotQuarantineReason): HostSnapshotValidation =>
    Object.freeze({ status: "quarantined" as const, reason, nextAction: snapshotGuidance("quarantined", reason) });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return fail("incomplete");
  const record = snapshot as Record<string, unknown>;
  if (record["snapshotContract"] !== SNAPSHOT_CONTRACT) {
    const versions = record["nativeFormatVersion"];
    if (typeof versions === "number" && (!Number.isSafeInteger(versions) || versions < 1 || versions > SNAPSHOT_NATIVE_FORMAT_VERSION)) return fail("unsupported-version");
    return fail("incomplete");
  }
  if (record["nativeFormatVersion"] !== SNAPSHOT_NATIVE_FORMAT_VERSION) {
    const version = record["nativeFormatVersion"];
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return fail("incomplete");
    return fail("unsupported-version");
  }
  if (typeof record["createdAt"] !== "string" || !Number.isFinite(Date.parse(record["createdAt"] as string))) return fail("incomplete");
  if (!Array.isArray(record["sessions"]) || record["sessions"].length > MAX_SNAPSHOT_SESSIONS) return fail("incomplete");
  const sessions = record["sessions"] as unknown[];
  const seen = new Set<string>();
  const references: import("./index.ts").HostSessionReference[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("incomplete");
    const session = entry as Record<string, unknown>;
    if (typeof session["id"] !== "string" || !ID_PATTERN.test(session["id"] as string) || seen.has(session["id"] as string)) return fail("incomplete");
    seen.add(session["id"] as string);
    if (typeof session["branchId"] !== "string" || !BRANCH_PATTERN.test(session["branchId"] as string)) return fail("incomplete");
    if (typeof session["workspaceRoot"] !== "string" || !(session["workspaceRoot"] as string).startsWith("/")) return fail("incomplete");
    if (typeof session["headerCreatedAt"] !== "string" || !Number.isFinite(Date.parse(session["headerCreatedAt"] as string))) return fail("incomplete");
    if (typeof session["nativeFormatVersion"] !== "number" || !Number.isSafeInteger(session["nativeFormatVersion"] as number) ||
        (session["nativeFormatVersion"] as number) < 1 || (session["nativeFormatVersion"] as number) > SNAPSHOT_NATIVE_FORMAT_VERSION) {
      const version = session["nativeFormatVersion"];
      if (typeof version === "number" && Number.isSafeInteger(version) && version > SNAPSHOT_NATIVE_FORMAT_VERSION) return fail("unsupported-version");
      return fail("incomplete");
    }
    if (typeof session["retired"] !== "boolean") return fail("incomplete");
    if (!Array.isArray(session["artifacts"]) || (session["artifacts"] as unknown[]).length < 1 || (session["artifacts"] as unknown[]).length > 2) return fail("missing-artifact");
    const artifacts = session["artifacts"] as unknown[];
    const kinds = new Set<string>();
    let hasConversation = false;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return fail("corrupt");
      const item = artifact as Record<string, unknown>;
      if (item["kind"] !== "conversation" && item["kind"] !== "metadata") return fail("corrupt");
      if (kinds.has(item["kind"] as string)) return fail("corrupt");
      kinds.add(item["kind"] as string);
      if (item["kind"] === "conversation") hasConversation = true;
      if (typeof item["size"] !== "number" || !Number.isSafeInteger(item["size"] as number) || (item["size"] as number) < 1 ||
          (item["size"] as number) > MAX_SNAPSHOT_ARTIFACT_BYTES) return fail("corrupt");
      if (typeof item["sha256"] !== "string" || !SHA_PATTERN.test(item["sha256"] as string)) return fail("corrupt");
      if (typeof item["dataBase64"] !== "string" || (item["dataBase64"] as string).length < 1 ||
          (item["dataBase64"] as string).length % 4 !== 0 || !BASE64_PATTERN.test(item["dataBase64"] as string)) return fail("corrupt");
      let decoded: Uint8Array;
      try {
        decoded = Buffer.from(item["dataBase64"] as string, "base64");
      } catch {
        return fail("corrupt");
      }
      if (decoded.length !== (item["size"] as number)) return fail("corrupt");
      if (decoded.length > MAX_SNAPSHOT_ARTIFACT_BYTES) return fail("corrupt");
      if (hashSnapshotBytes(decoded) !== (item["sha256"] as string)) return fail("corrupt");
    }
    if (!hasConversation) return fail("missing-artifact");
    references.push(Object.freeze({ id: session["id"] as string, branchId: session["branchId"] as string }));
  }
  return Object.freeze({ status: "valid" as const, sessions: Object.freeze(references), nextAction: snapshotGuidance("valid") });
}
