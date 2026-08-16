/**
 * pi stdin encoders + extension-UI auto-decline — source-lifted from
 * burrow's `src/runtime/pi.ts` (warren-7933, plan pl-3007). Split out of
 * `./pi.ts` for the file-size budget; behavior is byte-for-byte burrow's.
 *
 * Pi's `--mode rpc` reads one JSON command per `\n`-delimited line on
 * stdin. Each run writes a single `{"type":"prompt","message":"..."}` line
 * per prompt / steering message and then waits for the agent to drain.
 */

import type { AdapterRuntimeEvent, SteeringMessage } from "./types.ts";

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob — one `{"type":"prompt", ...}` JSON envelope per line.
 * Each pending steering message becomes its own prompt command, prefixed
 * with the standard `[STEERING] (priority: P) ` tag for parity with
 * claude-code (mx-63b005). Exported for unit tests.
 *
 * When the run carries no prompt (e.g. inbox-only nudge) the first line
 * is dropped, mirroring `encodeClaudeStdin`'s contract.
 */
export function encodePiStdin(prompt: string, messages: readonly SteeringMessage[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(piPromptCommand(prompt));
	for (const m of messages) lines.push(piPromptCommandFromMessage(m));
	return lines.map((l) => `${l}\n`).join("");
}

/**
 * Encode one steering message as a single prompt RPC line, terminated by
 * `\n` for pi's NDJSON read loop. Shared by `encodeInboxMessage`
 * (at-spawn) and `encodeSteeringMessage` (mid-run) so both paths emit the
 * identical wire shape (burrow-250d).
 */
export function piPromptCommandFromMessage(message: SteeringMessage): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return piPromptCommand(`${tag}${message.body}`);
}

function piPromptCommand(text: string): string {
	return JSON.stringify({ type: "prompt", message: text });
}

/**
 * Render a cancelled `extension_ui_response` for one
 * `extension_ui_request` payload, correlated by the request's `id`. The
 * auto-decline keeps an extensions-enabled batch run hang-safe: pi's
 * extension UI RPC is interactive and the dispatcher has no path to answer
 * it for real (burrow-12ba).
 */
export function encodeExtensionUiDecline(payload: unknown): string {
	const id = readStringField(payload, "id");
	return `${JSON.stringify({
		type: "extension_ui_response",
		id: id ?? null,
		cancelled: true,
	})}\n`;
}

/**
 * True when the event is pi's interactive `extension_ui_request` envelope
 * (collapsed to `state_change`/`system` by the parser with the raw
 * envelope preserved in `payload`).
 */
export function isPiExtensionUiRequest(event: AdapterRuntimeEvent): boolean {
	if (event.kind !== "state_change") return false;
	const payload = event.payload as { type?: unknown } | null | undefined;
	return !!payload && payload.type === "extension_ui_request";
}

function readStringField(payload: unknown, key: string): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const v = (payload as Record<string, unknown>)[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
