import { expect, test } from "bun:test";
import { activityDetail, statusPill } from "../src/tui/presentation.ts";
import type { TuiActivity } from "../src/tui/controller.ts";

const base: TuiActivity = { operationId: 1, phase: "waiting", elapsedMs: 6_100, activeTools: 0, toolNames: [], cancellation: "none" };
const words = (text: string) => text.split(" ").filter(word => word && word !== "·").length;
/** Retry metadata for every cause, a cause-less event, and a wait that has already run out. */
const retryFixtures = [undefined, ...[undefined, "rate-limit", "provider", "offline"].flatMap(cause => [1_100, 0, 29_500].map(remainingMs =>
  ({ failedAttempt: 2, maxAttempts: 3, remainingMs, ...(cause ? { cause: cause as "rate-limit" | "provider" | "offline" } : {}) })))];

test("tool activity counts use singular and plural nouns", () => {
  expect(activityDetail({ ...base, phase: "tools", activeTools: 1 })).toBe("Running 1 tool");
  expect(activityDetail({ ...base, phase: "tools", activeTools: 2 })).toBe("Running 2 tools");
});

test("every readiness, phase and cancellation label stays within six words", () => {
  for (const readiness of ["loading", "ready", "not-connected", "connect", "choose-model", "failed"]) {
    for (const status of ["idle", "running", "error"]) for (const tiny of [false, true]) {
      const pill = statusPill({ readiness, status }, tiny);
      expect(words(pill.label), pill.label).toBeLessThanOrEqual(6);
      expect(pill.label).not.toMatch(/^[A-Z ]{3,}$/);
    }
  }
  for (const phase of ["preparing", "waiting", "streaming", "tools", "compacting", "retry", "stopping"] as const)
    for (const cancellation of ["none", "requested", "settling"] as const)
      for (const elapsedMs of [0, 1_000, 65_000])
        for (const compactionOutcome of [undefined, "completed", "cancelled", "failed", "noop"] as const)
          for (const compactionReason of [undefined, "manual", "pressure", "overflow"] as const)
            for (const retry of retryFixtures) {
              const activity = { ...base, phase, cancellation, elapsedMs, compactionOutcome, compactionReason, retry,
                activeTools: 2, toolNames: ["very long tool display name", "another lengthy tool name", "third"] };
              for (const tiny of [false, true]) {
                const label = statusPill({ readiness: "ready", status: "running", activity }, tiny).label;
                expect(words(label), label).toBeLessThanOrEqual(6);
              }
              const detail = activityDetail(activity);
              expect(words(detail), detail).toBeLessThanOrEqual(6);
            }
});

test("retry copy names the cause, the upcoming attempt and a rounded-up wait, never a zero countdown", () => {
  const labels = { "rate-limit": "Rate limited", provider: "Provider unavailable", offline: "Connection lost" } as const;
  for (const retry of retryFixtures) {
    const activity = { ...base, phase: "retry" as const, retry };
    const pill = statusPill({ readiness: "ready", status: "running", activity }).label;
    const detail = activityDetail(activity);
    expect(detail).toEndWith(" · Esc stop");
    expect(pill).not.toMatch(/in 0s|-\d/);
    if (!retry) { expect(detail).toBe("Retrying request · Esc stop"); expect(pill).toBe("Retrying 6.1s"); continue; }
    expect(detail).toBe(`${retry.cause ? labels[retry.cause] : "Retrying request"} · Attempt 3/3 · Esc stop`);
    expect(pill).toBe(`Retry · Attempt 3/3 ${{ 1_100: "in 2s", 0: "now", 29_500: "in 30s" }[retry.remainingMs]}`);
    if (retry.cause !== "offline") expect(`${pill} ${detail}`.toLowerCase()).not.toContain("connection");
  }
});
