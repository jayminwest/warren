/** Only locally authored messages cross the HTTP/log boundary. */
export class TrackerFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 502,
		readonly retryAfter?: string,
	) {
		super(message);
	}
}

export class ConfigError extends Error {}

export function malformed(): never {
	throw new TrackerFailure(
		"upstream_invalid_response",
		"GitHub returned an incomplete or invalid response",
	);
}

export function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return malformed();
	return value as Record<string, unknown>;
}

export function string(value: unknown): string {
	if (typeof value !== "string") return malformed();
	return value;
}

export function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) return malformed();
	return value;
}
