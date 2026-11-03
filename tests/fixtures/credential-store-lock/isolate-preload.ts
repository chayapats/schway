// Keep test runs off the developer's real credential-store lock. Tests that
// save through the native store with an injected backend still take the real
// lock; without this, the run would leave ~/.schway/credential-store.lock as a
// lock file, and an earlier Schway installed from another checkout would then
// refuse every credential save. Child processes inherit the same isolated path.
import { afterAll } from "bun:test";
import { join } from "node:path";
// The temp-root guard imports only Node built-ins, so it is safe to preload.
import { makeTempRootSync, removeTempRootSync } from "../../helpers.ts";

if (!process.env.SCHWAY_CREDENTIAL_LOCK_FILE?.trim()) {
  const directory = makeTempRootSync("schway-test-credential-lock-");
  process.env.SCHWAY_CREDENTIAL_LOCK_FILE = join(directory, "credential-store.lock");
  // A preloaded hook runs once, after every test file.
  afterAll(() => removeTempRootSync(directory));
}
