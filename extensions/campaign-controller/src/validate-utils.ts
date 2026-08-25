/**
 * Small field-validation helpers shared by the campaign manifest and
 * repository-policy schemas (plan pl-91b6 step 2, warren-5055).
 *
 * Every helper throws `ValidationError` with a message of the form
 * `<context>: <what is wrong> at '<path>' — <expectation>`, so failures stay
 * actionable. Unknown keys are always rejected (fail-closed schemas): a
 * secret-bearing key like `token` is an unknown key, and unknown keys never
 * reach the normalized output.
 */
import { ValidationError } from "./errors.ts";

export type Json = Record<string, unknown>;

/** Require a JSON object; arrays and scalars fail. */
export function asObject(value: unknown, path: string): Json {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ValidationError(`expected an object at '${path}'`);
	}
	return value as Json;
}

/** Reject any key not in `known`, naming the offenders and the allowance. */
export function rejectUnknownKeys(value: Json, known: readonly string[], path: string): void {
	const unknown = Object.keys(value).filter((k) => !known.includes(k));
	if (unknown.length > 0) {
		throw new ValidationError(
			`unknown field(s) at '${path}': ${unknown.map((k) => `"${k}"`).join(", ")} — allowed fields: ${known.join(", ")}`,
		);
	}
}

function requireField(value: Json, key: string, path: string): unknown {
	if (!(key in value)) {
		throw new ValidationError(`missing required field at '${path}.${key}'`);
	}
	return value[key];
}

/** Require a non-empty bounded string, optionally pattern-checked. */
export function requireString(
	value: Json,
	key: string,
	path: string,
	options: { min?: number; max?: number; pattern?: RegExp; patternHint?: string } = {},
): string {
	const raw = requireField(value, key, path);
	if (typeof raw !== "string") {
		throw new ValidationError(`expected a string at '${path}.${key}'`);
	}
	if (options.min !== undefined && raw.length < options.min) {
		throw new ValidationError(`expected at least ${options.min} characters at '${path}.${key}'`);
	}
	if (options.max !== undefined && raw.length > options.max) {
		throw new ValidationError(`expected at most ${options.max} characters at '${path}.${key}'`);
	}
	if (options.pattern && !options.pattern.test(raw)) {
		throw new ValidationError(
			`invalid value at '${path}.${key}' — expected ${options.patternHint ?? "a matching value"}`,
		);
	}
	return raw;
}

/** Require a boolean. */
export function requireBoolean(value: Json, key: string, path: string): boolean {
	const raw = requireField(value, key, path);
	if (typeof raw !== "boolean") {
		throw new ValidationError(`expected a boolean at '${path}.${key}'`);
	}
	return raw;
}

/** Require an integer within an inclusive range. */
export function requireInt(
	value: Json,
	key: string,
	path: string,
	options: { min: number; max: number },
): number {
	const raw = requireField(value, key, path);
	if (typeof raw !== "number" || !Number.isInteger(raw)) {
		throw new ValidationError(`expected an integer at '${path}.${key}'`);
	}
	if (raw < options.min || raw > options.max) {
		throw new ValidationError(
			`expected an integer between ${options.min} and ${options.max} at '${path}.${key}', got ${raw}`,
		);
	}
	return raw;
}

/** Require a finite positive number (USD caps). */
export function requirePositiveNumber(value: Json, key: string, path: string, max: number): number {
	const raw = requireField(value, key, path);
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		throw new ValidationError(`expected a positive number at '${path}.${key}'`);
	}
	if (raw > max) {
		throw new ValidationError(`expected at most ${max} at '${path}.${key}', got ${raw}`);
	}
	return raw;
}

/** Require an https URL string. */
export function requireHttpsUrl(value: Json, key: string, path: string): string {
	const raw = requireString(value, key, path, { min: 1, max: 2048 });
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ValidationError(`expected an https URL at '${path}.${key}'`);
	}
	if (parsed.protocol !== "https:") {
		throw new ValidationError(`expected an https URL at '${path}.${key}'`);
	}
	return raw;
}

/** Require an ISO-8601 timestamp; return its normalized UTC form. */
export function requireIsoTimestamp(value: Json, key: string, path: string): string {
	const raw = requireString(value, key, path, { min: 1, max: 64 });
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new ValidationError(`expected an ISO-8601 timestamp at '${path}.${key}'`);
	}
	return parsed.toISOString();
}

/** Require a lowercase sha256 hex digest. */
export function requireSha256(value: Json, key: string, path: string): string {
	const raw = requireString(value, key, path, {
		min: 64,
		max: 64,
		pattern: /^[0-9a-f]{64}$/,
		patternHint: "a lowercase 64-character sha256 hex digest",
	});
	return raw;
}

/** Require a non-empty array of unique non-empty bounded strings. */
export function requireStringArray(
	value: Json,
	key: string,
	path: string,
	options: { minItems?: number; maxItems?: number; maxLen?: number } = {},
): string[] {
	const raw = requireField(value, key, path);
	if (!Array.isArray(raw)) {
		throw new ValidationError(`expected an array at '${path}.${key}'`);
	}
	if (options.minItems !== undefined && raw.length < options.minItems) {
		throw new ValidationError(`expected at least ${options.minItems} items at '${path}.${key}'`);
	}
	if (options.maxItems !== undefined && raw.length > options.maxItems) {
		throw new ValidationError(`expected at most ${options.maxItems} items at '${path}.${key}'`);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string" || item.length === 0) {
			throw new ValidationError(`expected non-empty strings at '${path}.${key}'`);
		}
		if (options.maxLen !== undefined && item.length > options.maxLen) {
			throw new ValidationError(
				`expected items of at most ${options.maxLen} characters at '${path}.${key}'`,
			);
		}
		if (seen.has(item)) {
			throw new ValidationError(
				`duplicate item "${item}" at '${path}.${key}' — items must be unique`,
			);
		}
		seen.add(item);
		out.push(item);
	}
	return out;
}
