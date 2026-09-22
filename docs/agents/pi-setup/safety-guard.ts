/**
 * Safety Guard
 * - Confirm before running destructive / irreversible shell commands
 *   (auto-block when there is no UI to confirm, e.g. `-p` print mode).
 * - Confirm before writing/editing secret files (.env, keys, .ssh, .pem ...).
 *
 * Tweak the patterns below to taste, then /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Shell commands that must always be confirmed first.
const DANGEROUS_BASH: RegExp[] = [
	/\brm\s+(-\S*\s+)*-\S*r\S*f/i, // rm -rf / -fr / -r -f
	/\brm\s+(-\S*\s+)*-\S*f\S*r/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-\S*f/i,
	/\bgit\s+push\b[^\n]*(--force|(?:^|\s)-f(?:\s|$))/i,
	/\bdd\s+if=/i,
	/\bmkfs\b/i,
	/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
	/\bchmod\s+-R\s+777\b/i,
	/>\s*\/dev\/(sd|nvme|disk)/i,
];

// Secret file paths that must be confirmed before modifying.
const PROTECTED_PATH = /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)(id_rsa|id_ed25519)(\.pub)?$|\.pem$|\.p12$|(^|\/)\.ssh\/|(^|\/)\.aws\/credentials$/i;

/** Blocks sensitive writes and destructive commands until interactive confirmation is available. */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// 1) Destructive shell commands
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command ?? "";
			if (DANGEROUS_BASH.some((re) => re.test(cmd))) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Blocked destructive command (no UI to confirm): ${cmd}` };
				}
				const ok = await ctx.ui.confirm("⚠️ Dangerous command", `pi is about to run:\n\n${cmd}\n\nAllow it?`);
				if (!ok) return { block: true, reason: "User declined the command" };
			}
			return;
		}

		// 2) Writing/editing secret files
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: string; file_path?: string };
			const p = String(input.path ?? input.file_path ?? "");
			if (p && PROTECTED_PATH.test(p)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Blocked edit of a secret file (no UI to confirm): ${p}` };
				}
				const ok = await ctx.ui.confirm("⚠️ Secret file", `pi is about to modify:\n\n${p}\n\nAllow it?`);
				if (!ok) return { block: true, reason: "User declined editing the secret file" };
			}
		}
	});
}
