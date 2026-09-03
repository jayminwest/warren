/**
 * Leak assertions for scenario 39 (`39-public-exposure.ts`).
 *
 * Split out of `39-public-exposure.helpers.ts` under the per-file line
 * budget: the helpers keep the db seeder, the forbidden-token vocabulary
 * and the route derivation; this module owns every assertion that scans
 * an anonymous body for content that must never be on the wire.
 */

import {
	REDACTED_COST_PER_MERGED_PR_BUCKET_FIELDS,
	REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS,
	REDACTED_RUN_GROUP_FIELDS,
	REDACTED_RUN_TOTALS_FIELDS,
} from "../../../src/server/handlers/runs/analytics.ts";
import { AcceptanceError } from "../lib/assert.ts";
import {
	FORBIDDEN_FIELD_NAMES,
	FORBIDDEN_PATH_FRAGMENTS,
	SENTINELS,
	UNREDACTED_BEARER,
} from "./39-public-exposure.helpers.ts";

/**
 * Forge-wiring probes (warren-2600). The campaign's falsification test 2
 * holds this scenario green while the forge seam lands; these fragments
 * must never appear in an anonymous body NO MATTER which forge is wired:
 *
 *   - `fake-credential` — FakeForge's static git-credential secret
 *     (src/forge/fake/fake-forge.ts). A minted forge credential on the
 *     public wire is the exact leak class the seam exists to prevent.
 *   - `fake://` — FakeForge's clone/webUrl scheme. In THIS scenario's
 *     seeded world every URL is github.com-shaped, so a `fake://`
 *     fragment means a forge-private URL shape escaped into a public
 *     projection (e.g. an event payload carrying the raw webUrl where a
 *     scrubbed shape belongs).
 */
const FORBIDDEN_FORGE_FRAGMENTS: readonly string[] = ["fake-credential", "fake://"];

/**
 * Flow endpoints in the readable set that are NOT projections
 * (warren-a647): `GET /github-app/callback` is GitHub's redirect target
 * after App creation, and its authentication story is the single-use,
 * ten-minute `state` nonce — a bare anonymous hit (no `code`/`state`)
 * CORRECTLY answers 400 and converts nothing. The sweep therefore probes
 * it expecting that 400 and runs the same `assertNoLeak` over the error
 * body every other route gets — an error page is exactly where a careless
 * implementation would echo a `state` or a token back. This is a probe,
 * not a skip.
 */
export const FLOW_ROUTE_EXPECTED_STATUS: Readonly<Record<string, number>> = {
	"/github-app/callback": 400,
	// warren-48f8: the one-time setup-code redemption NEVER arms under
	// WARREN_AUTH=public, so the route 404s for a spectator — that 404 IS
	// the leak guard's guarantee (no code, no token, no page). The sweep
	// probes it expecting exactly that.
	"/setup": 404,
};

/**
 * Registration-flow pages whose responses build their own locked-down
 * header set instead of the projection baseline (see
 * `src/server/handlers/github-app.ts`): no `Vary: Authorization` because
 * the body never varies by caller, and `cache-control: no-store` already
 * forbids shared caching. The header sweep asserts THAT set for these
 * routes rather than the projection baseline.
 *
 * `/github-app/installed` (warren-54c7) is the manifest `setup_url`
 * return route — same anonymous flow page as its siblings: the id it
 * renders arrives on GitHub's own redirect query string, nothing
 * server-side varies by caller, so it rides the same shared
 * `htmlResponse` header set and the same exemption here.
 */
export const FLOW_PAGE_PATTERNS: ReadonlySet<string> = new Set([
	"/github-app/register",
	"/github-app/callback",
	"/github-app/installed",
	// warren-48f8: /setup is anonymous by necessity (a browser navigation
	// carries no bearer) and its responses — 404 unarmed, 400 spent, 200
	// redemption — build their own no-store header set like the flow pages.
	"/setup",
]);

/**
 * The one assertion the whole scenario exists for: `body` — the verbatim
 * bytes an anonymous caller received from `label` — carries no redacted
 * field name, no planted sentinel, no host path, and no live bearer.
 */
export function assertNoLeak(label: string, body: string): void {
	// The event scrubber censors the internal runtime handles on the KEY
	// (warren-5f59 / warren-d8f4), leaving `"sandboxId":"[redacted]"` on
	// the wire on purpose — the same posture as `Bearer [redacted]`. Blank
	// those censored pairs before the field-name scan so only a LIVE value
	// under the key trips it.
	const names = body
		.split('"sandboxId":"[redacted]"')
		.join("")
		.split('"sandboxRunId":"[redacted]"')
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
	for (const fragment of FORBIDDEN_FORGE_FRAGMENTS) {
		if (body.includes(fragment)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries a forge-private fragment ${JSON.stringify(fragment)} (${excerptAround(body, fragment)})`,
			);
		}
	}
}

/**
 * `GET /analytics/runs`: the USD rollups whose names collide with public
 * ones, checked structurally at the level they live on rather than by
 * substring. Field lists are imported so a re-classification reaches here.
 * warren-97ae: also walks `outcomes.costPerMergedPr` — the `overall` shape
 * and the byAgent/byModel/byProvider buckets — against the REDACTED
 * constants, so the public instance-wide `costPerMergedPrUsd` is fenced by
 * an explicit allowlist instead of the walk simply never descending there.
 */
export function assertAnalyticsRollupsAbsent(body: Record<string, unknown>): void {
	assertObject(body.totals, "totals");
	assertFieldsAbsent("totals", body.totals as Record<string, unknown>, REDACTED_RUN_TOTALS_FIELDS);
	for (const groupKey of ["byAgent", "byModel", "byProvider"]) {
		assertGroupRollupsAbsent(groupKey, body[groupKey], REDACTED_RUN_GROUP_FIELDS);
	}
	const outcomes = assertObject(body.outcomes, "outcomes") as Record<string, unknown>;
	const costPerMergedPr = assertObject(outcomes.costPerMergedPr, "outcomes.costPerMergedPr");
	const overall = assertObject(costPerMergedPr.overall, "outcomes.costPerMergedPr.overall");
	assertFieldsAbsent(
		"outcomes.costPerMergedPr.overall",
		overall,
		REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS,
	);
	for (const groupKey of ["byAgent", "byModel", "byProvider"]) {
		assertGroupRollupsAbsent(
			`outcomes.costPerMergedPr.${groupKey}`,
			costPerMergedPr[groupKey],
			REDACTED_COST_PER_MERGED_PR_BUCKET_FIELDS,
		);
	}
}

/** Unwrap a nested body object or fail loudly. */
function assertObject(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		throw new AcceptanceError(`GET /analytics/runs: expected a \`${path}\` object in the body`);
	}
	return value as Record<string, unknown>;
}

/** Refuse every redacted-named field that leaked into a spectator object. */
function assertFieldsAbsent(
	path: string,
	obj: Record<string, unknown>,
	redactedFields: readonly string[],
): void {
	for (const field of redactedFields) {
		if (field in obj) {
			throw new AcceptanceError(
				`GET /analytics/runs: ${path}.${field} is redacted for a spectator but present`,
			);
		}
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
		assertFieldsAbsent(`${groupKey}[]`, bucket, groupFields);
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
