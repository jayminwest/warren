/**
 * Scenario 39 — public-instance exposure guard (warren-c405 / pl-b82d step 21).
 *
 * The regression guard that makes the public-instance phase durable. Every
 * projection pl-b82d landed is an ALLOWLIST a future contributor can widen
 * by accident, and a one-day-clean grep is not a gate — so this scenario
 * drives a real `WARREN_AUTH=public` stack and asserts, end to end:
 *
 *   1. No blocked route answers 200 anonymously (401/403 only), enumerated
 *      from `API_ROUTE_POLICIES` so a newly-added blocked route is covered
 *      automatically.
 *   2. Every mutating route (POST / DELETE) is refused anonymously.
 *   3. `GET /runs/:id/inbox` does not drain the operator's steering queue —
 *      the operator's own poll afterwards still finds the message.
 *   4. No anonymous response body carries a redacted field name, a planted
 *      sentinel value, a host path, or a live bearer credential.
 *   5. A forced 500 narrates nothing (warren-4385).
 *   6. Exceeding the per-client event-stream cap is a 503 (warren-25f6),
 *      rotating the client-controlled LEFT-most `X-Forwarded-For` hop does
 *      not dodge it (warren-46a7), and neither does spreading streams
 *      across client keys past the GLOBAL cap (warren-b0bd).
 *   7. Anonymous reads are bounded: `GET /runs?limit=` is clamp-refused
 *      past 500 (warren-ee50) and an event replay is one bounded page the
 *      client pages beyond with `?since` (warren-2a8b) — never the whole
 *      transcript in one shot.
 *   8. The pre-auth preview-proxy preamble narrates nothing: cookie
 *      verification precedes any run lookup (warren-820e), so an
 *      anonymous caller — runId known, unknown, or remote — sees one
 *      uniform 401 and the R-12 501 never leaks the redacted
 *      `workerId`; the warren-e2a4 security headers still reach its
 *      below-the-gate envelopes (warren-b0bd).
 *   9. Fail-closed: token mode grants anonymity nothing, an unrecognized
 *      `WARREN_AUTH` refuses the boot, and public mode refuses to boot with
 *      an empty or non-matching org allowlist (warren-851b / warren-ce9b).
 *
 * Self-contained by construction: it boots its OWN warren on its OWN temp
 * root with a database seeded through warren's repos before boot (see
 * `39-public-exposure.helpers.ts`), so it needs no burrow dispatch, no
 * canopy CLI and no LLM — which is what makes it cheap enough to run in CI
 * (`.github/workflows/acceptance-public.yml`).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INTERNAL_ERROR_MESSAGE } from "../../../src/server/errors.ts";
import {
	REDACTED_RUN_GROUP_FIELDS,
	REDACTED_RUN_TOTALS_FIELDS,
} from "../../../src/server/handlers/runs/analytics.ts";
import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import {
	blockedRouteCalls,
	INBOX_BODY,
	POISON_AGENT_NAME,
	PUBLIC_ORG,
	poisonAgentRow,
	publicGetCalls,
	type SeededIds,
	seedPublicInstanceDb,
} from "./39-public-exposure.helpers.ts";
import {
	assertAnalyticsRollupsAbsent,
	assertNoLeak,
	assertPlanRunFailureReasonAbsent,
	FLOW_PAGE_PATTERNS,
	FLOW_ROUTE_EXPECTED_STATUS,
} from "./39-public-exposure.leaks.ts";
import {
	assertBoundedReads,
	assertPreviewProxyPreamble,
	assertStreamCapRefuses,
	MAX_STREAMS_GLOBAL,
	MAX_STREAMS_PER_CLIENT,
} from "./39-public-exposure.limits.ts";
import { writeSdStub } from "./39-public-exposure.sd-stub.ts";

/**
 * Floor on how many mutating (non-GET) routes the policy table must declare
 * as blocked. A tripwire, not a census: it catches a POST/DELETE that lost
 * its policy and silently fell out of the refusal sweep. Lower it only
 * alongside a route the diff actually DELETES — never to make CI green.
 * Last moved by warren-f787, which deleted `POST /projects/:id/agents/refresh`
 * with the canopy project tier (14 → 13). Before that, warren-5652 deleted
 * `POST /agents/refresh` with the canopy library tier (15 → 14).
 */
const MIN_MUTATING_BLOCKED_ROUTES = 13;
const BOOT_REFUSAL_TIMEOUT_MS = 20_000; // refused-boot hang floor

interface WhoamiBody {
	readonly identity: string;
	readonly capabilities: readonly string[];
}

interface InboxBody {
	readonly messages: readonly { readonly body: string }[];
}

interface ErrorEnvelope {
	readonly error: { readonly code: string; readonly message?: string; readonly hint?: string };
}

export const scenario: Scenario = {
	id: "39",
	title: "public instance: no blocked route answers 200 anonymously, no redacted field on the wire",
	// Boots its own warren on its own temp root (like scenario 19) and drives
	// process-level boot refusals — in-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		// Fail-closed part 1 (step 12): the OUTER harness stack runs with
		// WARREN_AUTH unset, i.e. the default token backend. A credential-less
		// caller gets nothing there — public mode is opt-in, never a fallback.
		const tokenModeRes = await fetch(`${ctx.warrenUrl}/runs`);
		assertEqual(tokenModeRes.status, 401, "WARREN_AUTH unset: anonymous GET /runs is 401");
		assertNoLeak("token-mode anonymous GET /runs", await tokenModeRes.text());

		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-39-"));
		// warren-b754: ready-plans is `readPublic`; the stub answers every seeds read empty.
		const sdStubPath = await writeSdStub(scenarioRoot);
		// Inherit the outer harness's insteadOf redirects so the seeded
		// project's GitHub URL never reaches the network if anything on the
		// boot path decides to fetch it.
		const gitConfigPath = join(scenarioRoot, "git-config");
		await writeFile(gitConfigPath, await readFile(join(ctx.tmp, "git-config"), "utf8"));

		let handle: BootHandle | undefined;
		try {
			const ids = await seedPublicInstanceDb({
				tmpRoot: scenarioRoot,
				instanceToken: ctx.token,
			});
			ctx.logger.info(`scenario-39: seeded public instance (${JSON.stringify(ids)})`);

			handle = await bootInProc({
				tmpRoot: scenarioRoot,
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_AUTH: "public",
					WARREN_PUBLIC_ALLOWLIST: PUBLIC_ORG,
					// warren-e320: the /github-app/* registration gate defaults OFF
					// on a public instance; this scenario's job includes probing the
					// flow pages' leak behavior, so it opts the surface back ON
					// explicitly (the exact operator override the gate honors).
					WARREN_GITHUB_APP_REGISTRATION: "on",
					WARREN_MAX_EVENT_STREAMS_PER_CLIENT: String(MAX_STREAMS_PER_CLIENT),
					WARREN_MAX_EVENT_STREAMS: String(MAX_STREAMS_GLOBAL),
					// No triggers on the seeded project; keep the tick loop out of
					// the way for the life of the scenario.
					WARREN_SCHEDULER_TICK_MS: "3600000",
					// warren-b754: empty-envelope tracker for the ready-plans sweep;
					// the tick keeps the plan-run coordinator off the seeded row too.
					WARREN_SD_BINARY: sdStubPath,
					WARREN_PLAN_RUN_TICK_MS: "3600000",
				},
			});
			const base = handle.warrenUrl;
			const operator = new WarrenHttp({ baseUrl: base, token: ctx.token });
			ctx.logger.info(`scenario-39: public-mode warren ready at ${base}`);

			await assertWhoamiIsSpectator(base);
			await assertBlockedRoutesRefused(base, ids, ctx.logger.debug);
			await assertNoLeakOnPublicReads(base, ids, ctx.logger.debug);
			await assertInboxNotDrained(base, operator, ids);
			await assertBoundedReads(base, ids);
			await assertPreviewProxyPreamble(base, ids);
			await assertStreamCapRefuses(base, operator, ids);
			await assertSecurityHeadersAndVary(base, ids, ctx.logger.debug);
			// Poison LAST: warren-f787 deleted the project tier, so the row is
			// visible to `GET /agents` and would 500 the read sweep above.
			await poisonAgentRow(scenarioRoot);
			await assertForcedFiveHundredSaysNothing(base, ids);

			// Fail-closed part 2: three boot configurations that must REFUSE.
			// Same seeded db, fresh port each time so a bind can't be the reason.
			await assertBootRefused(handle, "unrecognized WARREN_AUTH", { WARREN_AUTH: "publik" });
			await assertBootRefused(handle, "public mode with an empty org allowlist", {
				WARREN_AUTH: "public",
				WARREN_PUBLIC_ALLOWLIST: "",
			});
			await assertBootRefused(handle, "public mode with a non-matching org allowlist", {
				WARREN_AUTH: "public",
				WARREN_PUBLIC_ALLOWLIST: "some-other-org",
			});
		} finally {
			// `stop()` removes the temp root; on a pre-boot failure nothing owns
			// it yet, so clean up by hand rather than leave a stray dir behind.
			if (handle !== undefined) await handle.stop();
			else await rm(scenarioRoot, { recursive: true, force: true });
		}
	},
};

/** `GET /whoami` names the spectator and hands out exactly `readPublic`. */
async function assertWhoamiIsSpectator(base: string): Promise<void> {
	const res = await fetch(`${base}/whoami`);
	assertEqual(res.status, 200, "anonymous GET /whoami is 200 under public mode");
	const body = (await res.json()) as WhoamiBody;
	assertEqual(body.identity, "anonymous", "GET /whoami identity for a credential-less caller");
	assertEqual(
		[...(body.capabilities ?? [])].sort().join(","),
		"readPublic",
		"a spectator holds readPublic and nothing else",
	);
}

/**
 * Assertion groups 1 + 2. Every blocked route is refused, and the mutating
 * half of that set is non-empty and refused to the last route — the "minus
 * dispatch" product scope, proven on the wire rather than in a table.
 */
async function assertBlockedRoutesRefused(
	base: string,
	ids: SeededIds,
	debug: (msg: string) => void,
): Promise<void> {
	const calls = blockedRouteCalls(ids);
	assertTrue(calls.length > 0, "the policy table declares at least one blocked route");
	let mutations = 0;
	for (const call of calls) {
		const res = await anonymousCall(base, call.method, call.path);
		const body = await res.text();
		if (res.status !== 401 && res.status !== 403) {
			throw new AcceptanceError(
				`${call.method} ${call.pattern}: anonymous caller got ${res.status}, expected 401/403 — a blocked route is reachable: ${body.slice(0, 400)}`,
			);
		}
		assertNoLeak(`anonymous ${call.method} ${call.pattern}`, body);
		if (call.method !== "GET") mutations += 1;
		debug(`scenario-39: ${call.method} ${call.pattern} → ${res.status}`);
	}
	assertTrue(
		mutations >= MIN_MUTATING_BLOCKED_ROUTES,
		`expected the policy table to declare at least ${MIN_MUTATING_BLOCKED_ROUTES} mutating routes, saw ${mutations} — did a POST/DELETE route lose its policy?`,
	);
}

/** Assertion group 4, over every route a spectator may actually read. */
async function assertNoLeakOnPublicReads(
	base: string,
	ids: SeededIds,
	debug: (msg: string) => void,
): Promise<void> {
	const calls = publicGetCalls(ids);
	for (const call of calls) {
		const res = await fetch(`${base}${call.path}`);
		// warren-a647: flow endpoints (the github-app callback) are probed,
		// not skipped — a bare hit correctly answers 400 (the `state` nonce
		// is the route's authentication), and the error body gets the same
		// leak scan as every projection body.
		const expected = FLOW_ROUTE_EXPECTED_STATUS[call.pattern] ?? 200;
		if (res.status !== expected) {
			throw new AcceptanceError(
				`GET ${call.pattern}: expected ${expected} for a spectator, got ${res.status}: ${(await res.text()).slice(0, 400)}`,
			);
		}
		const body = await res.text();
		assertTrue(body.length > 0, `GET ${call.pattern}: empty body — the sweep would pass vacuously`);
		assertNoLeak(`anonymous GET ${call.pattern}`, body);
		debug(`scenario-39: GET ${call.pattern} clean (${res.status}, ${body.length} bytes)`);
	}

	// The two rollup families whose names collide with public ones, checked
	// structurally instead of by substring.
	const analytics = await fetch(`${base}/analytics/runs`);
	assertAnalyticsRollupsAbsent(
		(await analytics.json()) as Record<string, unknown>,
		REDACTED_RUN_TOTALS_FIELDS,
		REDACTED_RUN_GROUP_FIELDS,
	);

	// warren-30cc: `to=` without `from=` must not drop the lower bound and
	// scan the whole runs table — the default window applies and the span
	// stays clamped, echoed back in the filter block.
	const windowed = await fetch(`${base}/analytics/runs?to=2030-01-01`);
	assertEqual(windowed.status, 200, "anonymous GET /analytics/runs?to=… is 200");
	const windowedBody = (await windowed.json()) as {
		filter: { from: string | null; to: string | null };
	};
	assertTrue(
		windowedBody.filter.from !== null,
		"analytics window with to= and no from= carried no lower bound — the default window was skipped",
	);
	const spanMs =
		Date.parse(windowedBody.filter.to ?? "") - Date.parse(windowedBody.filter.from ?? "");
	assertTrue(
		Number.isFinite(spanMs) && spanMs <= 91 * 24 * 60 * 60 * 1000,
		`analytics window span exceeded the 90-day clamp (from=${windowedBody.filter.from} to=${windowedBody.filter.to})`,
	);

	// The stream is the widest surface, so pin its two positive obligations
	// too: the scrubber left its marker, and the internal-only kind is gone.
	const stream = await fetch(`${base}/runs/${encodeURIComponent(ids.runId)}/events`);
	assertEqual(stream.status, 200, "anonymous GET /runs/:id/events is 200 under public mode");
	const ndjson = await stream.text();
	assertNoLeak("anonymous GET /runs/:id/events", ndjson);
	assertTrue(
		ndjson.includes("[redacted]"),
		"the event stream carried no [redacted] marker — the scrubber did not run on the planted secrets",
	);
	assertTrue(
		!ndjson.includes("bridge_lost"),
		"the event stream served the internal-only `bridge_lost` kind to a spectator",
	);
	// warren-b0bd: the handle-carrying kinds stay on the stream (the fact
	// is spectator-visible) but the handles themselves are censored on the
	// key (warren-5f59 / warren-d8f4). The sentinel VALUES are already
	// covered by assertNoLeak above; here pin that the kinds survived.
	for (const kind of ["watchdog.terminal_reconciled", "reap.workspace_destroyed"]) {
		assertTrue(
			ndjson.includes(kind),
			`the event stream dropped ${kind} — it is censored, not internal-only`,
		);
	}

	// `failureReason` is redacted on both plan-run projections but public
	// on runs, so the raw body scan can't hold it — walk the parsed bodies
	// and refuse the key wherever it nests (warren-b0bd).
	const planRuns = await fetch(`${base}/plan-runs`);
	assertPlanRunFailureReasonAbsent("anonymous GET /plan-runs", await planRuns.json());
	const planRunRes = await fetch(`${base}/plan-runs/${encodeURIComponent(ids.planRunId)}`);
	// The detail payload fans out `runs[]`, where `failureReason` IS public
	// — hold the key only on the plan-run halves of the body.
	const detail = (await planRunRes.json()) as { planRun: unknown; children: unknown };
	assertPlanRunFailureReasonAbsent("anonymous GET /plan-runs/:id planRun", detail.planRun);
	assertPlanRunFailureReasonAbsent("anonymous GET /plan-runs/:id children", detail.children);
}

/**
 * warren-e2a4: every projected route emits `Vary: Authorization` — an
 * operator sees more fields than a spectator at the same URL, so a shared
 * cache in front (a CDN toggle away) must never key the two together —
 * and every response carries the baseline security headers. The UI shell
 * is checked too: the operator token lives in browser storage on that
 * origin, so CSP / frame-ancestors are not cosmetic there.
 */
async function assertSecurityHeadersAndVary(
	base: string,
	ids: SeededIds,
	debug: (msg: string) => void,
): Promise<void> {
	const required: readonly string[] = [
		"content-security-policy",
		"x-content-type-options",
		"referrer-policy",
		"x-frame-options",
		"strict-transport-security",
	];
	for (const call of publicGetCalls(ids)) {
		const res = await fetch(`${base}${call.path}`);
		// warren-a647: the github-app registration flow pages build their
		// own locked-down header set (no Vary/HSTS — the body never varies
		// by caller and `cache-control: no-store` forbids shared caching);
		// assert THAT set here instead of the projection baseline.
		if (FLOW_PAGE_PATTERNS.has(call.pattern)) {
			const expected = FLOW_ROUTE_EXPECTED_STATUS[call.pattern] ?? 200;
			assertEqual(
				res.status,
				expected,
				`GET ${call.pattern} answers ${expected} for the header sweep`,
			);
			await res.body?.cancel();
			for (const name of [
				"content-security-policy",
				"x-content-type-options",
				"referrer-policy",
				"x-frame-options",
			]) {
				assertTrue(
					res.headers.get(name) !== null,
					`GET ${call.pattern}: missing security header ${name}`,
				);
			}
			assertTrue(
				(res.headers.get("cache-control") ?? "").includes("no-store"),
				`GET ${call.pattern}: no cache-control: no-store — a flow page must never be shared-cached`,
			);
			debug(`scenario-39: GET ${call.pattern} flow-page headers clean`);
			continue;
		}
		assertEqual(res.status, 200, `GET ${call.pattern} is 200 for the header sweep`);
		await res.body?.cancel();
		assertTrue(
			(res.headers.get("vary") ?? "").toLowerCase().includes("authorization"),
			`GET ${call.pattern}: no Vary: Authorization — a shared cache could serve an operator body to a spectator`,
		);
		for (const name of required) {
			assertTrue(
				res.headers.get(name) !== null,
				`GET ${call.pattern}: missing security header ${name}`,
			);
		}
		debug(`scenario-39: GET ${call.pattern} headers clean`);
	}
	const ui = await fetch(`${base}/`);
	await ui.body?.cancel();
	for (const name of required) {
		assertTrue(ui.headers.get(name) !== null, `GET / (UI shell): missing security header ${name}`);
	}
}

/**
 * Assertion group 3. `GET /runs/:id/inbox` MUTATES on read (it claims
 * unread rows), so the check is not "did it 403" alone — it is that the
 * operator's own poll afterwards still finds the message.
 */
async function assertInboxNotDrained(
	base: string,
	operator: WarrenHttp,
	ids: SeededIds,
): Promise<void> {
	const path = `/runs/${encodeURIComponent(ids.runId)}/inbox`;
	const anonymous = await fetch(`${base}${path}`);
	assertEqual(anonymous.status, 403, "anonymous GET /runs/:id/inbox is refused");
	const claimed = await operator.expectJson<InboxBody>("GET", path, 200);
	const bodies = claimed.messages.map((m) => m.body);
	assertTrue(
		bodies.includes(INBOX_BODY),
		`the operator's inbox poll lost the seeded message — the anonymous poll drained it (got ${JSON.stringify(bodies)})`,
	);
}

/**
 * Assertion group 5. `GET /agents` lists the agent whose `rendered_json`
 * {@link poisonAgentRow} just left unparseable, so the handler raises an
 * untyped SyntaxError — the one class of throw whose message must never
 * reach the wire (warren-4385).
 */
async function assertForcedFiveHundredSaysNothing(base: string, _ids: SeededIds): Promise<void> {
	const res = await fetch(`${base}/agents`);
	assertEqual(res.status, 500, "the poison agent row forces an unhandled 500");
	const raw = await res.text();
	const envelope = JSON.parse(raw) as ErrorEnvelope;
	assertEqual(envelope.error?.code, "internal_error", "a forced 500 uses the internal_error code");
	assertEqual(
		envelope.error?.message,
		INTERNAL_ERROR_MESSAGE,
		"a forced 500 carries the fixed generic message, never the thrown one",
	);
	for (const fragment of ["JSON", "SyntaxError", "not json", POISON_AGENT_NAME]) {
		assertTrue(
			!raw.includes(fragment),
			`a forced 500 narrated ${JSON.stringify(fragment)} to the caller: ${raw}`,
		);
	}
	assertNoLeak("anonymous forced 500", raw);
}

/**
 * Re-spawn the warren entrypoint against the SAME seeded database with
 * `overrides` applied, and require a non-zero exit. A fresh bind port so a
 * refusal can never be mistaken for a port conflict.
 */
async function assertBootRefused(
	handle: BootHandle,
	label: string,
	overrides: Record<string, string>,
): Promise<void> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/server/main/index.ts"],
		env: {
			...handle.env,
			WARREN_BIND_PORT: String(32_000 + Math.floor(Math.random() * 28_000)),
			...overrides,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const outcome = await Promise.race([
		proc.exited,
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), BOOT_REFUSAL_TIMEOUT_MS),
		),
	]);
	if (outcome === "timeout") {
		proc.kill("SIGKILL");
		await proc.exited.catch(() => 0);
		throw new AcceptanceError(
			`fail-closed: ${label} did not refuse the boot — the process was still up after ${BOOT_REFUSAL_TIMEOUT_MS}ms`,
		);
	}
	if (outcome === 0) {
		throw new AcceptanceError(`fail-closed: ${label} booted successfully (exit 0); it must refuse`);
	}
}

/** Anonymous request; mutations carry an empty JSON object so the gate, not a parse error, decides. */
async function anonymousCall(base: string, method: string, path: string): Promise<Response> {
	if (method === "GET") return fetch(`${base}${path}`, { method });
	return fetch(`${base}${path}`, {
		method,
		body: "{}",
		headers: { "content-type": "application/json" },
	});
}
