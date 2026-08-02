/**
 * Duration-string parser for the preview config (R-19 / docs/design/preview-environments.md).
 *
 * The schema (`src/warren-config/schema.ts` `DurationStringSchema`) validates
 * shape only — accepting one-or-more `<number><unit>` pairs (`30m`, `8h`,
 * `1h30m`, `500ms`). Consumers parse to milliseconds at use time so the
 * config layer stays storage-agnostic and the eviction worker doesn't need
 * to know the schema regex.
 *
 * Throws `ValidationError` for any value that doesn't match the same shape
 * the schema accepts. Callers that read directly from env wrap parse
 * failures with the source env-var name (see `loadPreviewEvictionConfig`).
 */

import { ValidationError } from "../core/errors.ts";

const UNIT_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

const DURATION_TOKEN_RE = /(\d+)(ms|s|m|h|d)/g;
const DURATION_SHAPE_RE = /^(\d+(ms|s|m|h|d))+$/;

/**
 * Convert a duration string (e.g. `"30m"`, `"1h30m"`, `"500ms"`) to
 * milliseconds. Throws `ValidationError` on malformed input.
 */
export function parseDurationMs(raw: string): number {
	const trimmed = raw.trim();
	if (trimmed === "" || !DURATION_SHAPE_RE.test(trimmed)) {
		throw new ValidationError(
			`duration must be one or more <number><unit> pairs (units: ms, s, m, h, d), got ${JSON.stringify(raw)}`,
			{ recoveryHint: 'example: "30m", "8h", "1h30m"' },
		);
	}
	let total = 0;
	for (const match of trimmed.matchAll(DURATION_TOKEN_RE)) {
		const value = Number.parseInt(match[1] as string, 10);
		const unit = match[2] as string;
		const multiplier = UNIT_MS[unit];
		if (multiplier === undefined) {
			throw new ValidationError(`unknown duration unit '${unit}'`);
		}
		total += value * multiplier;
	}
	return total;
}
