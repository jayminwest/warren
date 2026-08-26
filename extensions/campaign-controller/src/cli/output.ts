/**
 * CLI output: NDJSON by default, optional human rendering (warren-d050).
 *
 * Every emitted line — success or error — is scrubbed against the known
 * credential values before it reaches stdout, so an untrusted detail string
 * that happens to embed a token can never echo it. Secrets are only ever
 * supplied through named environment variables, and they never appear in
 * errors, output, or state.
 */
import { errorPayload } from "./exit-codes.ts";

export type OutputFormat = "ndjson" | "human";

export interface CommandIo {
	readonly format: OutputFormat;
	emitSuccess(command: string, result: unknown): void;
	emitError(command: string, error: unknown): void;
}

export interface IoOptions {
	readonly write: (text: string) => void;
	/** Credential values scrubbed from every emitted line. */
	readonly secrets: readonly string[];
}

export function createIo(format: OutputFormat, options: IoOptions): CommandIo {
	return {
		format,
		emitSuccess(command, result) {
			if (format === "human") {
				options.write(renderHuman(command, result));
				return;
			}
			options.write(scrub(JSON.stringify({ ok: true, command, result }), options.secrets));
			options.write("\n");
		},
		emitError(command, error) {
			const payload = errorPayload(error);
			if (format === "human") {
				options.write(
					scrub(`${command}: failed (${payload.code})\n  ${payload.message}\n`, options.secrets),
				);
				return;
			}
			options.write(
				scrub(
					JSON.stringify({
						ok: false,
						command,
						error: payload,
					}),
					options.secrets,
				),
			);
			options.write("\n");
		},
	};
}

/** Remove every occurrence of a known secret from `text`. */
function scrub(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length > 0) {
			out = out.split(secret).join("[redacted]");
		}
	}
	return out;
}

/** Readable rendering: one line per top-level key, nested values as JSON. */
function renderHuman(command: string, result: unknown): string {
	const lines = [`${command}: ok`];
	if (typeof result === "object" && result !== null) {
		for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
			lines.push(`  ${key}: ${renderValue(value)}`);
		}
	} else {
		lines.push(`  ${String(result)}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderValue(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return String(value);
	}
	return JSON.stringify(value);
}
