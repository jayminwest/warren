/**
 * Leak assertions for scenario 39 (`39-public-exposure.ts`).
 *
 * Split out of `39-public-exposure.helpers.ts` under the per-file line
 * budget: the helpers keep the db seeder, the forbidden-token vocabulary
 * and the route derivation; this module owns every assertion that scans
 * an anonymous body for content that must never be on the wire.
 */

import { AcceptanceError } from "../lib/assert.ts";
import {
	FORBIDDEN_FIELD_NAMES,
	FORBIDDEN_PATH_FRAGMENTS,
	SENTINELS,
	UNREDACTED_BEARER,
} from "./39-public-exposure.helpers.ts";

/**
 * The one assertion the whole scenario exists for: `body` — the verbatim
 * bytes an anonymous caller received from `label` — carries no redacted
 * field name, no planted sentinel, no host path, and no live bearer.
 */
export function assertNoLeak(label: string, body: string): void {
	// The event scrubber censors the internal runtime handles on the KEY
	// (warren-5f59 / warren-d8f4), leaving `"burrowId":"[redacted]"` on
	// the wire on purpose — the same posture as `Bearer [redacted]`. Blank
	// those censored pairs before the field-name scan so only a LIVE value
	// under the key trips it.
	const names = body
		.split('"burrowId":"[redacted]"')
		.join("")
		.split('"burrowRunId":"[redacted]"')
		.join("");
	for (const name of FORBIDDEN_FIELD_NAMES) {
		if (names.includes(name)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries redacted field name ${JSON.stringify(name)} — a public projection widened (${excerptAround(body, name)})`,
			);
		}
	}
	for (const [key, sentinel] of Object.entries(SENTINELS)) {
		if (body.includes(sentinel)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries the ${key} sentinel value (${excerptAround(body, sentinel)})`,
			);
		}
	}
	for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
		if (body.includes(fragment)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries a host path fragment ${JSON.stringify(fragment)} (${excerptAround(body, fragment)})`,
			);
		}
	}
	const bearer = UNREDACTED_BEARER.exec(body);
	if (bearer !== null) {
		throw new AcceptanceError(
			`${label}: anonymous body carries an unredacted bearer credential (${excerptAround(body, bearer[0])})`,
		);
	}
}

/**
 * `GET /analytics/runs`: the USD rollups whose names collide with public
 * ones, checked structurally at the level they live on rather than by
 * substring. Field lists are imported so a re-classification reaches here.
 */
export function assertAnalyticsRollupsAbsent(
	body: Record<string, unknown>,
	totalsFields: readonly string[],
	groupFields: readonly string[],
): void {
	const totals = body.totals;
	if (totals === null || typeof totals !== "object") {
		throw new AcceptanceError("GET /analytics/runs: expected a `totals` object in the body");
	}
	for (const field of totalsFields) {
		if (field in (totals as Record<string, unknown>)) {
			throw new AcceptanceError(
				`GET /analytics/runs: totals.${field} is redacted for a spectator but present`,
			);
		}
	}
	for (const groupKey of ["byAgent", "byModel", "byProvider"]) {
		assertGroupRollupsAbsent(groupKey, body[groupKey], groupFields);
	}
}

/** One `byAgent` / `byModel` / `byProvider` bucket array. */
function assertGroupRollupsAbsent(
	groupKey: string,
	buckets: unknown,
	groupFields: readonly string[],
): void {
	if (!Array.isArray(buckets)) {
		throw new AcceptanceError(`GET /analytics/runs: expected \`${groupKey}\` to be an array`);
	}
	for (const bucket of buckets as readonly Record<string, unknown>[]) {
		for (const field of groupFields) {
			if (field in bucket) {
				throw new AcceptanceError(
					`GET /analytics/runs: ${groupKey}[].${field} is redacted for a spectator but present`,
				);
			}
		}
	}
}

/**
 * `GET /plan-runs` / `GET /plan-runs/:id`: `failureReason` is redacted on
 * BOTH plan-run projections but public on runs, so a substring scan can't
 * hold it. Walk the parsed bodies and refuse the KEY wherever it appears —
 * top level, list rows, nested children (warren-b0bd).
 */
export function assertPlanRunFailureReasonAbsent(label: string, body: unknown): void {
	const stack: unknown[] = [body];
	while (stack.length > 0) {
		const value = stack.pop();
		if (Array.isArray(value)) {
			stack.push(...value);
			continue;
		}
		if (typeof value !== "object" || value === null) continue;
		if ("failureReason" in (value as Record<string, unknown>)) {
			throw new AcceptanceError(
				`${label}: a plan-run body carries failureReason — redacted for a spectator but present`,
			);
		}
		stack.push(...Object.values(value as Record<string, unknown>));
	}
}

/** A short window around `needle` so a failure names the offending bytes. */
function excerptAround(body: string, needle: string): string {
	const at = body.indexOf(needle);
	if (at < 0) return "no excerpt";
	const from = Math.max(0, at - 60);
	return `…${body.slice(from, at + needle.length + 60)}…`;
}
