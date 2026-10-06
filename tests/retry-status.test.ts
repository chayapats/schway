import { expect, test } from "bun:test";
import { formatRetryWait, retryAttemptLabel, retryCauseLabel } from "../src/text/retry-status.ts";

test("retry waits round up to whole seconds and read now once nothing remains", () => {
  expect([3_000, 1_800, 1_001, 1_000, 1, 0, -250, Number.NaN, 61_200].map(formatRetryWait))
    .toEqual(["in 3s", "in 2s", "in 2s", "in 1s", "in 1s", "now", "now", "now", "in 1m 2s"]);
});

test("retry labels number the upcoming attempt and blame the connection only when offline", () => {
  expect(retryAttemptLabel(1, 3)).toBe("Attempt 2/3");
  expect(retryAttemptLabel(2, 3)).toBe("Attempt 3/3");
  expect([retryCauseLabel("rate-limit"), retryCauseLabel("provider"), retryCauseLabel("offline"), retryCauseLabel(undefined)])
    .toEqual(["Rate limited", "Provider unavailable", "Connection lost", "Retrying request"]);
});
