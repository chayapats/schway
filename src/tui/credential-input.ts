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
    const callback = controller.snapshot().loginCallbackEntry;
    const endpoint = controller.snapshot().endpointUrlEntry;
    if (!entry && !callback && !endpoint) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.eventType === "release") return;
    const name = key.name.toLowerCase();
    if (name === "escape" || (key.ctrl && (name === "c" || name === "d"))) {
      controller.cancel();
    } else if (name === "return" || name === "enter") {
      void (entry ? controller.submitCredential() : endpoint ? Promise.resolve(controller.submitEndpointUrl()) : controller.submitLoginCallback()).then(render, () => {
        controller.fail("Sign-in could not complete. Check the saved credential or retry the callback.");
        render();
      });
    } else if (name === "backspace" || name === "delete") {
      if (entry) controller.backspaceCredential(); else if (endpoint) controller.backspaceEndpointUrl(); else controller.backspaceLoginCallback();
    } else if (!key.ctrl && !key.meta && !key.option && !key.super && !key.hyper && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
      if (entry) controller.enterCredentialText(key.sequence); else if (endpoint) controller.enterEndpointUrlText(key.sequence); else controller.enterLoginCallbackText(key.sequence);
    }
    render();
  };
  const paste = (event: PasteEvent) => {
    const entry = controller.snapshot().credentialEntry;
    const endpoint = controller.snapshot().endpointUrlEntry;
    if (!entry && !endpoint && !controller.snapshot().loginCallbackEntry) return;
    event.preventDefault();
    event.stopPropagation();
    if (entry) controller.enterCredentialText(new TextDecoder().decode(event.bytes));
    else if (endpoint) controller.enterEndpointUrlText(new TextDecoder().decode(event.bytes));
    else controller.enterLoginCallbackText(new TextDecoder().decode(event.bytes));
    render();
  };
  input.prependListener("keypress", keypress);
  input.prependListener("paste", paste);
  return () => { input.off("keypress", keypress); input.off("paste", paste); };
}
