/**
 * Bounded-read and stream-cap assertion groups for scenario 39
 * (`39-public-exposure.ts`), split out under the per-file line budget:
 *
 *   - assertion group 6 — the event-stream caps: per-client (warren-25f6),
 *     the X-Forwarded-For left-most spoof (warren-46a7), and the global
 *     instance cap (warren-b0bd);
 *   - assertion group 7 — anonymous reads are bounded: the `?limit` clamp
 *     (warren-ee50) and the one-page event replay (warren-2a8b);
 *   - assertion group 8 — the pre-auth preview-proxy preamble leaks
 *     nothing and carries the security-header baseline (warren-b0bd).
 */

import { DEFAULT_SNAPSHOT_PAGE_LIMIT } from "../../../src/runs/events.ts";
import { AcceptanceError, assertEqual, assertTrue } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";
import type { SeededIds } from "./39-public-exposure.helpers.ts";
import { assertNoLeak } from "./39-public-exposure.leaks.ts";

/** Per-client event-stream cap the scenario boots with (warren-25f6). */
export const MAX_STREAMS_PER_CLIENT = 2;
/**
 * Instance-wide event-stream cap (warren-b0bd). Deliberately NOT a
 * multiple of the per-client cap: filling it takes three distinct client
 * keys (2 + 2 + 1), which is exactly the shape the global-cap assertion
 * drives.
 */
export const MAX_STREAMS_GLOBAL = 5;

/**
 * Assertion group 7 (warren-b0bd). Two unbounded-read levers an anonymous
 * caller could otherwise lean on, both proven bounded on the wire:
 *
 *   - `GET /runs?limit=` past the clamp is a 400, not a silent full-table
 *     scan (warren-ee50).
 *   - An event replay is ONE bounded page of
 *     `DEFAULT_SNAPSHOT_PAGE_LIMIT` rows (warren-2a8b); the seeder planted
 *     page+1 events, so a full-transcript reply would be one line longer
 *     than the cap. The client reaches the tail with `?since`.
 */
export async function assertBoundedReads(base: string, ids: SeededIds): Promise<void> {
	const overLimit = await fetch(`${base}/runs?limit=99999`);
	assertEqual(overLimit.status, 400, "anonymous GET /runs?limit=99999 is refused, not scanned");
	assertNoLeak("anonymous GET /runs?limit=99999", await overLimit.text());

	const eventsPath = `/runs/${encodeURIComponent(ids.runId)}/events`;
	const page = await fetch(`${base}${eventsPath}`);
	assertEqual(page.status, 200, "anonymous event replay is 200");
	const lines = (await page.text()).trim().split("\n");
	// The seeder planted PAGE+1 rows; the page is exactly PAGE rows, of
	// which the internal-only `bridge_lost` is dropped from the wire.
	assertEqual(
		lines.length,
		DEFAULT_SNAPSHOT_PAGE_LIMIT - 1,
		"anonymous event replay is exactly one bounded page (the seeder planted page+1 events)",
	);
	const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { seq?: number };
	assertTrue(typeof last.seq === "number", "the last replayed line carries a seq to page from");
	const rest = await fetch(`${base}${eventsPath}?since=${last.seq}`);
	assertEqual(rest.status, 200, "anonymous event replay with ?since is 200");
	const restLines = (await rest.text()).trim().split("\n");
	assertEqual(
		restLines.length,
		1,
		"?since pages past the snapshot bound to the one remaining event",
	);
}

/**
 * Assertion group 8 (warren-b0bd). The preview-proxy preamble runs BEFORE
 * the auth gate (`src/server/server.ts`), so its envelopes reach anonymous
 * callers verbatim — the one pre-auth surface the route-policy sweep can
 * never see. The seeded run carries the `workerId` sentinel, which trips
 * the cross-host 501: the body must not quote the sentinel back
 * (warren-946f classifies `workerId` as operator-only), and the
 * warren-e2a4 security headers must reach even this below-the-gate
 * response. An unknown run id is a clean 404.
 */
export async function assertPreviewProxyPreamble(base: string, ids: SeededIds): Promise<void> {
	const crossHost = await fetch(`${base}/p/${encodeURIComponent(ids.runId)}/`);
	assertEqual(
		crossHost.status,
		501,
		"anonymous preview-proxy hit on a remote-worker run is the R-12 501",
	);
	assertNoLeak("anonymous preview-proxy 501", await crossHost.text());
	assertTrue(
		crossHost.headers.get("content-security-policy") !== null,
		"the preview-proxy preamble response carries the security-header baseline",
	);

	const unknown = await fetch(`${base}/p/acceptance-unreached/`);
	assertEqual(unknown.status, 404, "anonymous preview-proxy hit on an unknown run is 404");
	assertNoLeak("anonymous preview-proxy 404", await unknown.text());
}

/**
 * Assertion group 6. Hold the per-client allowance open with follow
 * streams, then prove the next one is refused fast (503) rather than
 * queued on a single-replica control plane.
 *
 * The slots are held against the PLAN-RUN stream, not the run stream:
 * the seeded run is terminal (it must be — boot-time bridge resume
 * reconciles a seeded `running` run to `burrow_run_lost`), and since
 * warren-7bff a follow tail on a terminal run closes right after
 * replay, releasing its slot before the next probe. The plan-run tail
 * holds until the client disconnects, so it pins the slots
 * deterministically — and it is the costlier stream to leave uncapped
 * (it fans in every child), so it is the better route to prove the cap
 * on anyway. Both routes share the same limiter (warren-25f6).
 */
export async function assertStreamCapRefuses(
	base: string,
	operator: WarrenHttp,
	ids: SeededIds,
): Promise<void> {
	const url = `${base}/plan-runs/${encodeURIComponent(ids.planRunId)}/events?follow=1`;
	const held: AbortController[] = [];
	const hold = async (headers?: HeadersInit): Promise<void> => {
		const ctrl = new AbortController();
		held.push(ctrl);
		const res = await fetch(url, {
			signal: ctrl.signal,
			...(headers !== undefined ? { headers } : {}),
		});
		assertEqual(res.status, 200, `follow stream ${held.length} within the caps is admitted`);
	};
	const expectRefused = async (label: string, headers?: HeadersInit): Promise<void> => {
		const refused = await fetch(url, headers !== undefined ? { headers } : {});
		assertEqual(refused.status, 503, `${label}: the over-cap follow stream is refused`);
		assertTrue(
			refused.headers.get("retry-after") !== null,
			`${label}: a capacity 503 advertises Retry-After`,
		);
		assertNoLeak(`${label}: anonymous capacity 503`, await refused.text());
	};
	try {
		// Per-client cap (warren-25f6): fill one client's allowance, then the
		// next stream from the same client is a fast 503.
		for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) await hold();
		await expectRefused("per-client cap");
		for (const ctrl of held.splice(0)) ctrl.abort();
		// Slot release rides connection teardown, which is asynchronous —
		// wait for the gauge or the aborted streams would still count
		// against the GLOBAL cap the later phases fill.
		await waitForActiveStreams(operator, 0);

		// XFF spoof (warren-46a7): the client controls everything LEFT of the
		// trusted edge's hop. Rotating the left-most entries while keeping the
		// right-most constant must NOT mint a fresh per-client allowance.
		for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
			await hold({ "x-forwarded-for": `198.51.100.${i + 1}, 203.0.113.7` });
		}
		await expectRefused("XFF left-most rotation", {
			"x-forwarded-for": "198.51.100.99, 203.0.113.7",
		});
		for (const ctrl of held.splice(0)) ctrl.abort();
		await waitForActiveStreams(operator, 0);

		// Global cap (warren-b0bd): three distinct client keys fill the
		// instance budget (2 + 2 + 1 = MAX_STREAMS_GLOBAL); a FOURTH key —
		// with its per-client allowance untouched — is still refused, and the
		// refusal names the instance, not the client.
		for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
			await hold({ "x-forwarded-for": "203.0.113.10" });
		}
		for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) {
			await hold({ "x-forwarded-for": "203.0.113.11" });
		}
		await hold({ "x-forwarded-for": "203.0.113.12" });
		const refused = await fetch(url, { headers: { "x-forwarded-for": "203.0.113.13" } });
		assertEqual(refused.status, 503, "global cap: a fresh client key is still refused");
		const body = await refused.text();
		assertTrue(
			body.includes("instance"),
			`global cap: the 503 names instance saturation, not the client: ${body.slice(0, 300)}`,
		);
		assertNoLeak("global cap: anonymous capacity 503", body);
	} finally {
		for (const ctrl of held) ctrl.abort();
	}
}

/**
 * Poll the operator-only `/metrics` gauge until the instance-wide
 * event-stream count reaches `expected` — the observable proof that
 * aborted follow streams have released their slots (warren-b0bd).
 */
async function waitForActiveStreams(operator: WarrenHttp, expected: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const res = await operator.expectStatus("GET", "/metrics", 200);
		const match = /^warren_event_streams (\d+)$/m.exec(await res.text());
		if (match !== null && Number(match[1]) === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new AcceptanceError(`event-stream slots did not drain to ${expected} within 10s`);
}
