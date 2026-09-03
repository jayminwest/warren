import { describe, expect, test } from "bun:test";
import type { RoutePolicy } from "../types.ts";
import { API_ROUTE_POLICIES, isAuthExempt } from "./index.ts";

/* isAuthExempt tests (extracted from handlers.preview.test.ts, warren-599c / pl-9088 step 3). */

describe("isAuthExempt", () => {
	test("/healthz remains auth-exempt", () => {
		expect(isAuthExempt("/healthz")).toBe(true);
	});

	test("/version is auth-exempt (warren-6ea5)", () => {
		expect(isAuthExempt("/version")).toBe(true);
	});

	test("/runs/<id>/preview/login is gated (warren-e1b0 dropped the exemption)", () => {
		expect(isAuthExempt("/runs/run_abc/preview/login")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/")).toBe(false);
	});

	test("/metrics is gated (warren-682a — public-Ingress exposure)", () => {
		expect(isAuthExempt("/metrics")).toBe(false);
	});

	test("other /runs/* surfaces remain gated", () => {
		expect(isAuthExempt("/runs")).toBe(false);
		expect(isAuthExempt("/runs/run_abc")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/events")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/extra")).toBe(false);
	});

	test("the exempt set is exactly the anonymous-policy routes (warren-b875)", () => {
		const anonymous = API_ROUTE_POLICIES.filter((r) => r.policy === "anonymous").map(
			(r) => r.pattern,
		);
		expect(anonymous.every((p) => isAuthExempt(p))).toBe(true);
		for (const route of API_ROUTE_POLICIES) {
			if (route.policy === "anonymous") continue;
			// Every other API pattern must be gated; a `:param` pattern is never
			// itself a real pathname, but it still lives under an API prefix.
			expect(isAuthExempt(route.pattern)).toBe(false);
		}
	});

	test("anonymous routes are static paths — a :param pattern could never match", () => {
		for (const route of API_ROUTE_POLICIES) {
			if (route.policy !== "anonymous") continue;
			expect(route.pattern).not.toContain(":");
		}
	});
});

/**
 * Route-policy classification (warren-b875). ROUTE_TABLE is the security
 * boundary of a `WARREN_AUTH=public` instance, so the classification is
 * asserted here as literal data: widening a route to the spectator surface
 * has to be a deliberate edit to THIS list, never a side effect of adding a
 * route. The wire-level proof that the classification is actually enforced
 * lives in `policy.wire.test.ts`.
 */
describe("ROUTE_TABLE policy classification", () => {
	const key = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`;
	const policyOf = (route: string): RoutePolicy | undefined =>
		API_ROUTE_POLICIES.find((r) => key(r) === route)?.policy;

	/** The whole surface a credential-less spectator may reach. */
	const SPECTATOR_ROUTES: readonly string[] = [
		"GET /healthz",
		"GET /version",
		"GET /whoami", // reflects the caller's own request back at it (warren-e195)
		"GET /instance", // reduced static facts projection (warren-2eec)
		"GET /agents",
		"GET /agents/:name",
		"GET /projects",
		"GET /projects/:id", // same projection as the list (warren-2a89)
		// warren-b754: spectator-visible on the project detail page.
		"GET /projects/:id/ready-plans", // ids + open-child counts only
		"GET /projects/:id/warren-config", // narrowed envelope (no triggers/errors, redacted defaults)
		"GET /analytics/runs",
		// pl-7e38 step 12 (warren-d850): reduced projection — the USD sums are
		// stripped, windowRuns/delivery/services stay (./ops-overview.ts).
		"GET /ops/overview",
		// pl-7e38 step 15 (warren-5eec): per-row `projectEvent` reduction —
		// exactly what the per-run public stream shows for each row.
		"GET /events",
		"GET /runs",
		"GET /runs/:id",
		"GET /runs/:id/events",
		"GET /plan-runs",
		"GET /plan-runs/:id",
		"GET /plan-runs/:id/events",
		// warren-a647: App registration is a browser flow (no bearer rides a
		// navigation/redirect); /register discloses nothing server-side and
		// /callback refuses without a live single-use state nonce.
		"GET /github-app/register",
		"GET /github-app/callback",
		// warren-54c7: GitHub's post-install redirect target; renders only what
		// the query string carries (the installation id), nothing server-side.
		"GET /github-app/installed",
		// warren-48f8: one-time setup code redemption — anonymous by necessity
		// (browser navigation carries no bearer); the single-use code IS the
		// auth, and the handoff never arms under WARREN_AUTH=public (the route
		// 404s there, so a spectator learns nothing from it).
		"GET /setup",
	];

	/** Reads that must stay operator-only — each with the reason it is here. */
	const OPERATOR_READS: readonly string[] = [
		"GET /readyz", // failed-check disclosure
		"GET /metrics", // cumulative cost + operational shape (warren-682a)
		"GET /analytics/cost", // instance-wide USD rollup
		"GET /analytics/behavior", // cross-run tool/command mining
		"GET /analytics/dispatch", // dispatch-context log (warren-5423)
		"GET /runs/:id/inbox", // DESTRUCTIVE ON READ — drains the steering queue
		"GET /runs/:id/finalize-intent", // pod callback; pollable to race the pod
		"GET /projects/:id/triggers", // trigger prompts + qualityGate commands
		"GET /projects/:id/seeds/plans", // project issue contents
		"GET /projects/:id/seeds/:seedId", // project issue contents
		"GET /preview/config", // discloses WARREN_PREVIEW_HOST
	];

	/**
	 * Reads promoted to `readPublic` (warren-b754) with what the spectator
	 * body still drops — recorded beside the old operator entries so the
	 * promotion is a decision on record, not a silent gate change.
	 */
	const PROMOTED_READS: readonly string[] = [
		"GET /projects/:id/ready-plans", // ids + open-child counts only
		"GET /projects/:id/warren-config", // narrowed envelope: no triggers, no errors, redacted defaults
	];

	test("every route declares a policy from the known vocabulary", () => {
		const legal: readonly RoutePolicy[] = [
			"anonymous",
			"readPublic",
			"readOperator",
			"dispatch",
			"admin",
		];
		expect(API_ROUTE_POLICIES.length).toBeGreaterThan(0);
		for (const route of API_ROUTE_POLICIES) {
			expect(legal).toContain(route.policy);
		}
	});

	test("the spectator surface is exactly the enumerated routes", () => {
		const reachable = API_ROUTE_POLICIES.filter(
			(r) => r.policy === "anonymous" || r.policy === "readPublic",
		).map(key);
		expect(reachable.sort()).toEqual([...SPECTATOR_ROUTES].sort());
	});

	test("every operator-only read is blocked to a spectator", () => {
		const misclassified = OPERATOR_READS.filter((r) => policyOf(r) !== "readOperator");
		expect(misclassified).toEqual([]);
	});

	test("promoted reads answer a spectator", () => {
		const stale = PROMOTED_READS.filter((r) => policyOf(r) === "readOperator");
		expect(stale).toEqual([]);
	});

	test("every POST and DELETE requires dispatch or admin", () => {
		const mutating = API_ROUTE_POLICIES.filter((r) => r.method !== "GET");
		expect(mutating.length).toBeGreaterThan(0);
		const reachable = mutating.filter((r) => r.policy !== "dispatch" && r.policy !== "admin");
		expect(reachable.map(key)).toEqual([]);
	});
});
