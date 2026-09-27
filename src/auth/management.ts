import { credentialEnvironmentVariable } from "./credentials.ts";
import { credentialIdentity, credentialStoreError, type CredentialIdentity, type CredentialStore, type CredentialTarget } from "./store.ts";

/** Secret-free result of an explicit credential mutation. */
export type CredentialMutationResult = { ok: boolean; message: string };

/** Hold masked entry outside normal editor state and commit a selected identity only on submit. */
export class MaskedCredentialEntry {
  #buffer = "";
  #phase: "entry" | "saving" | "saved" | "cancelled" | "failed" = "entry";
  #pending?: Promise<CredentialMutationResult>;
  #identity: CredentialIdentity;
  #store: CredentialStore;
  #rememberSecret?: (secret: string) => void;

  constructor(options: { identity: CredentialIdentity; store: CredentialStore; rememberSecret?: (secret: string) => void }) {
    this.#identity = options.identity;
    this.#store = options.store;
    this.#rememberSecret = options.rememberSecret;
  }

  /** Return only safe display state, never the entry buffer. */
  snapshot() {
    return { phase: this.#phase, label: this.#identity.label, masked: "•".repeat(Math.min(this.#buffer.length, 64)) };
  }

  /** Append printable entry text; reject embedded controls and cap API keys at 16 KiB. */
  insert(text: string): void {
    if (this.#phase !== "entry") return;
    const value = text.replace(/[\r\n]+$/, "");
    if (/[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(this.#buffer + value, "utf8") > 16_384) {
      this.#buffer = "";
      this.#phase = "failed";
      return;
    }
    this.#buffer += value;
  }

  /** Remove the last entered code point while the entry remains editable. */
  backspace(): void {
    if (this.#phase === "entry") this.#buffer = [...this.#buffer].slice(0, -1).join("");
  }

  /** Erase pending input without changing the store; submitted native writes cannot be cancelled. */
  cancel(): boolean {
    if (this.#phase === "saving" || this.#phase === "saved") return false;
    this.#buffer = "";
    this.#phase = "cancelled";
    return true;
  }

  /** Save once, clearing input immediately and exposing only a secret-free outcome. */
  submit(): Promise<CredentialMutationResult> {
    if (this.#pending) return this.#pending;
    if (this.#phase !== "entry") return Promise.resolve({ ok: false, message: "Credential entry was cancelled or invalid; nothing saved." });
    const key = this.#buffer.trim();
    this.#buffer = "";
    if (!key) {
      this.#phase = "failed";
      return Promise.resolve({ ok: false, message: "API key is empty; nothing saved." });
    }
    this.#phase = "saving";
    this.#rememberSecret?.(key);
    this.#pending = this.#save(key);
    return this.#pending;
  }

  async #save(key: string): Promise<CredentialMutationResult> {
    try {
      await this.#store.set(this.#identity, key);
      this.#phase = "saved";
      return { ok: true, message: `Saved API key for ${this.#identity.label} in the OS secure store.` };
    } catch {
      this.#phase = "failed";
      return { ok: false, message: credentialStoreError("save") };
    }
  }
}

/** Delete only the explicit stored identity and describe overrides that deletion cannot remove. */
export async function removeStoredCredential(input: CredentialTarget & {
  store: CredentialStore;
  runtimeApiKey?: string;
  credentialEnv?: string;
  env: Record<string, string | undefined>;
}): Promise<CredentialMutationResult> {
  let identity: CredentialIdentity;
  try { identity = credentialIdentity(input); }
  catch { return { ok: false, message: "Select a valid HTTP(S) base URL before managing OpenAI-compatible credentials." }; }
  let deleted: boolean;
  try { deleted = await input.store.delete(identity); }
  catch { return { ok: false, message: credentialStoreError("delete") }; }
  const variable = input.provider === "openai-compatible" && input.credentialEnv
    ? input.credentialEnv : credentialEnvironmentVariable(input.provider);
  const remaining: string[] = [];
  if (input.runtimeApiKey !== undefined) remaining.push("The runtime --api-key override is unchanged");
  if (input.env[variable]?.trim()) remaining.push(`${variable} is still set`);
  const overrides = remaining.length ? ` ${remaining.join("; ")}; restart without these overrides to stop using them.` : "";
  return {
    ok: true,
    message: `${deleted ? "Removed stored API key" : "No stored API key found"} for ${identity.label}.${overrides}`,
  };
}
