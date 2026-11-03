// Keep test runs off the developer's real credential-store lock. Tests that
// save through the native store with an injected backend still take the real
// lock; without this, the run would leave ~/.schway/credential-store.lock as a
// lock file, and an earlier Schway installed from another checkout would then
// refuse every credential save. Child processes inherit the same isolated path.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SCHWAY_CREDENTIAL_LOCK_FILE?.trim()) {
  const directory = mkdtempSync(join(tmpdir(), "schway-test-credential-lock-"));
  process.env.SCHWAY_CREDENTIAL_LOCK_FILE = join(directory, "credential-store.lock");
  // A preloaded hook runs once, after every test file.
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
}
