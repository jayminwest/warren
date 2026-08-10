/**
 * Body-field validators for constrained shapes (warren-b27c).
 *
 * `optionalString` (in `./index.ts`) only proves the JSON type; every caller
 * that then cast the result to a union was trusting the client with the
 * vocabulary. The drizzle enum columns are TS-only narrowing and the repo
 * carries no SQL CHECK, so an unknown value persisted verbatim and poisoned
 * downstream lookups — an unknown steering `priority` made the inbox rank
 * lookup `undefined`, so the delivery comparator returned NaN and `Array.sort`
 * ordering became implementation-defined.
 *
 * These live in their own module rather than `./index.ts` so the route-table
 * composer stays under the `check:size` budget.
 */

import { ValidationError } from "../../core/errors.ts";

/**
 * An optional body field constrained to a canonical wire enum. Membership is
 * checked at the boundary against the canonical tuple in `src/core/wire.ts` —
 * never a second local copy (`check:wire-types`).
 */
export function optionalEnum<T extends string>(
	body: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new ValidationError(`field '${key}' must be one of: ${allowed.join(", ")}`, {
			recoveryHint: `Use one of: ${allowed.join(", ")}.`,
		});
	}
	return value as T;
}

/**
 * An optional body field that must be a positive finite JSON number. The
 * first consumer is `POST /runs` `maxCostUsd` (the warren-a63d spend cap):
 * a cap of zero, a negative, or a string would otherwise coerce downstream
 * into "no cap" (fail-open), so the boundary rejects it loudly instead.
 */
export function optionalPositiveNumber(
	body: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ValidationError(`field '${key}' must be a positive number`);
	}
	return value;
}

/**
 * An optional body field that must be a JSON object. Rejects arrays, strings,
 * and numbers instead of casting them to a record and letting a non-object
 * reach persistence.
 */
export function optionalObject(
	body: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`field '${key}' must be a JSON object`);
	}
	return value as Record<string, unknown>;
}
