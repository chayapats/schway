import { expect, test } from "bun:test";
import { activityDetail, statusPill } from "../src/tui/presentation.ts";
import type { TuiActivity } from "../src/tui/controller.ts";

const base: TuiActivity = { operationId: 1, phase: "waiting", elapsedMs: 6_100, activeTools: 0, toolNames: [], cancellation: "none" };
const words = (text: string) => text.split(" ").filter(word => word && word !== "·").length;

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
            for (const retry of [undefined, { failedAttempt: 1, maxAttempts: 3, remainingMs: 1_100 }]) {
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
