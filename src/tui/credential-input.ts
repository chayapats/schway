import type { KeyEvent, KeyHandler, PasteEvent } from "@opentui/core";
import type { TuiController } from "./controller.ts";

/** Lazy-load the renderer with raw-input debug capture disabled before any terminal input is read. */
export async function loadCredentialSafeTui(): Promise<typeof import("@opentui/core")> {
  process.env.OTUI_DEBUG = "0";
  process.env.OTUI_STDIN_LOG = "";
  const core = await import("@opentui/core");
  // OpenTUI caches parsed environment values; an earlier import must not retain raw logging.
  core.clearEnvCache();
  return core;
}

/** Intercept masked-entry events before normal editor handlers and return a listener cleanup function. */
export function bindCredentialInput(input: KeyHandler, controller: TuiController, render: () => void): () => void {
  const keypress = (key: KeyEvent) => {
    const entry = controller.snapshot().credentialEntry;
    if (!entry) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.eventType === "release") return;
    const name = key.name.toLowerCase();
    if (name === "escape" || (key.ctrl && (name === "c" || name === "d"))) {
      controller.cancel();
    } else if (name === "return" || name === "enter") {
      void controller.submitCredential().then(render, () => {
        controller.fail("Credential operation could not complete. Check secure-store access and retry.");
        render();
      });
    } else if (name === "backspace" || name === "delete") {
      controller.backspaceCredential();
    } else if (!key.ctrl && !key.meta && !key.option && !key.super && !key.hyper && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
      controller.enterCredentialText(key.sequence);
    }
    render();
  };
  const paste = (event: PasteEvent) => {
    if (!controller.snapshot().credentialEntry) return;
    event.preventDefault();
    event.stopPropagation();
    controller.enterCredentialText(new TextDecoder().decode(event.bytes));
    render();
  };
  input.prependListener("keypress", keypress);
  input.prependListener("paste", paste);
  return () => { input.off("keypress", keypress); input.off("paste", paste); };
}
