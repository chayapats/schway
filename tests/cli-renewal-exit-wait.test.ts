import { expect, test } from "bun:test";
import { createRenewalExit, RENEWAL_EXIT_LIMIT_MS, RENEWAL_TERMINATE_LIMIT_MS, RENEWED_SIGN_IN_NOT_SAVED, SAVING_RENEWED_SIGN_IN,
  SAVING_RENEWED_SIGN_IN_HINT, type RenewalExitOptions } from "../src/cli/renewal-exit.ts";

/** An exit wait over a renewal the test settles, recording stderr. */
function exitWait(options: Partial<RenewalExitOptions> & { pending?: boolean } = {}) {
  const lines: string[] = [];
  const outcome = Promise.withResolvers<boolean>();
  const exit = createRenewalExit({ stderr: { write: text => { lines.push(text); } }, interactive: false, limitMs: 60_000, terminateLimitMs: 60_000,
    renewals: { pending: () => options.pending ?? true, settled: () => outcome.promise }, ...options });
  return { exit, lines, settle: (saved: boolean) => outcome.resolve(saved) };
}

test("the exit bounds cover the refresh ceiling, the lock wait and a short termination grace", () => {
  expect(RENEWAL_EXIT_LIMIT_MS).toBe(35_000);
  expect(RENEWAL_TERMINATE_LIMIT_MS).toBe(5_000);
});

test("with no renewal in flight, exit is immediate and silent", async () => {
  const wait = exitWait({ pending: false });
  expect(await wait.exit.settle(3)).toBe(3);
  expect(wait.lines).toEqual([]);
});

test("a saved renewal exits with the command's status after one status line", async () => {
  const wait = exitWait();
  const settling = wait.exit.settle(1);
  wait.settle(true);
  expect(await settling).toBe(1);
  expect(wait.lines).toEqual([`${SAVING_RENEWED_SIGN_IN}\n`]);
});

test("a terminal shows the Ctrl+C hint beside the status", async () => {
  const wait = exitWait({ interactive: true });
  const settling = wait.exit.settle(0);
  wait.settle(true);
  expect(await settling).toBe(0);
  expect(wait.lines).toEqual([`${SAVING_RENEWED_SIGN_IN} · ${SAVING_RENEWED_SIGN_IN_HINT}\n`]);
});

test("a renewal that ends without a saved sign-in warns and keeps the command's status", async () => {
  const wait = exitWait();
  const settling = wait.exit.settle(1);
  wait.settle(false);
  expect(await settling).toBe(1);
  expect(wait.lines).toEqual([`${SAVING_RENEWED_SIGN_IN}\n`, `${RENEWED_SIGN_IN_NOT_SAVED}\n`]);
});

test("a store write that never returns ends at the hard limit with a warning and the command's status", async () => {
  const wait = exitWait({ limitMs: 20 });
  const started = performance.now();
  expect(await wait.exit.settle(2)).toBe(2);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(wait.lines.at(-1)).toBe(`${RENEWED_SIGN_IN_NOT_SAVED}\n`);
});

test("Ctrl+C during the wait quits at once with a warning", async () => {
  const wait = exitWait();
  const settling = wait.exit.settle(1);
  wait.exit.interrupt();
  expect(await settling).toBe(130);
  expect(wait.lines.at(-1)).toBe(`${RENEWED_SIGN_IN_NOT_SAVED}\n`);
});

test("two Ctrl+C presses before the wait skip it", async () => {
  const wait = exitWait();
  wait.exit.interrupt(); wait.exit.interrupt();
  expect(await wait.exit.settle(1)).toBe(130);
  expect(wait.lines).toEqual([`${RENEWED_SIGN_IN_NOT_SAVED}\n`]);
});

test("one Ctrl+C before the wait still waits for the renewal", async () => {
  const wait = exitWait();
  wait.exit.interrupt();
  const settling = wait.exit.settle(1);
  wait.settle(true);
  expect(await settling).toBe(1);
  expect(wait.lines).toEqual([`${SAVING_RENEWED_SIGN_IN}\n`]);
});

for (const when of ["before", "during"] as const) test(`SIGTERM ${when} the wait caps it at the termination limit`, async () => {
  const wait = exitWait({ terminateLimitMs: 20 });
  if (when === "before") wait.exit.terminate();
  const settling = wait.exit.settle(1);
  if (when === "during") wait.exit.terminate();
  const started = performance.now();
  expect(await settling).toBe(143);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(wait.lines.at(-1)).toBe(`${RENEWED_SIGN_IN_NOT_SAVED}\n`);
});

test("a renewal saved inside the termination cap still exits cleanly", async () => {
  const wait = exitWait({ terminateLimitMs: 1_000 });
  wait.exit.terminate();
  const settling = wait.exit.settle(1);
  wait.settle(true);
  expect(await settling).toBe(1);
  expect(wait.lines).toEqual([`${SAVING_RENEWED_SIGN_IN}\n`]);
});

test("a second SIGTERM quits at once, before or during the wait", async () => {
  const during = exitWait();
  during.exit.terminate();
  const settling = during.exit.settle(1);
  during.exit.terminate();
  expect(await settling).toBe(143);
  expect(during.lines.at(-1)).toBe(`${RENEWED_SIGN_IN_NOT_SAVED}\n`);
  const before = exitWait();
  before.exit.terminate(); before.exit.terminate();
  expect(await before.exit.settle(1)).toBe(143);
  expect(before.lines).toEqual([`${RENEWED_SIGN_IN_NOT_SAVED}\n`]);
});
