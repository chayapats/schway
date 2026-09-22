// Subprocess tests must never reach the developer's real OS credential store.
Object.defineProperty(Bun, "secrets", {
  value: {
    async get() { return null; },
    async set() { throw new Error("Credential writes are disabled in CLI subprocess tests"); },
    async delete() { throw new Error("Credential deletions are disabled in CLI subprocess tests"); },
  },
});
