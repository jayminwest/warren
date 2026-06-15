/**
 * Scenario 20 — per-run preview environments end-to-end (R-19, pl-2c59 step 11).
 *
 * Plan pl-2c59's acceptance criterion #10:
 *   "Acceptance scenario 20 passes both variants (happy path + TTL eviction)
 *    against a live warren+burrow stack on Linux; macOS skip is documented
 *    (mx-1d31f0 pattern)."
 *
 * Two variants share one file — each boots its own warren+burrow stack with
 * a preview-enabled project fixture so the env knobs the variant cares about
 * (`WARREN_PREVIEW_IDLE_TTL`, `WARREN_PREVIEW_EVICTION_TICK_MS`) can be set
 * at boot. The fixture is built inside the scenario's own tmp dir from the
 * harness's sample-source clone plus a tiny `.warren/defaults.json` + a
 * portable preview command (`python3 -m http.server`), so the shared
 * harness fixture stays untouched and other scenarios are unaffected.
 *
 * ## Variant A — happy path
 *
 * Dispatch a run against a project with `preview` opted in, assert the run
 * succeeds and the 5th best-effort reap sub-step (`preview_launch`) lifts
 * the row to `preview_state='live'` with a `preview_port` assigned. Then
 * exercise the host reverse proxy preamble:
 *
 *   - `Host: run-<id>.<preview-host>` without a cookie → 401 (the proxy
 *     points the browser at `/runs/:id/preview/login`).
 *   - `GET /runs/:id/preview/login?token=…&redirect=…` → 302 + `Set-Cookie:
 *     warren_preview=…`.
 *   - Replay the same `Host` header with the issued cookie → 200; the
 *     upstream body proves the proxy forwarded into the sidecar.
 *
 * PR-open / annotate assertions are deferred: the harness's git-config
 * redirects push at a non-bare fixture clone with no GitHub remote, and
 * `pr_open` skips silently with `reap_failed` step=pr_open (scenario 09
 * has the same caveat / scope cut, warren-c37e). The launch path itself
 * is what this scenario locks down.
 *
 * ## Variant B — idle-TTL eviction
 *
 * Boot a separate stack with `WARREN_PREVIEW_IDLE_TTL=2s` and a fast
 * tick (`WARREN_PREVIEW_EVICTION_TICK_MS=500`). Dispatch a run, wait for
 * `preview_state='live'`, then **make no proxy requests** so
 * `preview_last_hit_at` stays null and the idle clock falls back to
 * `preview_started_at` (mx-…). Past the 2s window the eviction worker
 * transitions the row to `torn-down` and emits `preview_evicted` with
 * `reason='idle_ttl'`. Port released back to the allocator.
 *
 * ## Skip conditions
 *
 *   - **macOS** — burrow's bwrap-based inbound-port-forwarding (R-08, the
 *     transport the proxy depends on) is Linux-only. Seatbelt doesn't
 *     isolate the network namespace, so the host port the allocator
 *     hands out has nothing listening on it and the readiness probe
 *     times out. Documented in burrow's `inbound-forward.ts` and warren
 *     `mx-1d31f0`; same posture as scenarios 13/14.
 *   - **Postgres dialect** — the SPEC §11.L port allocator and eviction
 *     worker are sqlite-only today (R-13 follow-up, mx-b82a55). When the
 *     harness is dispatched with `WARREN_TEST_DIALECT=postgres` the
 *     scenario skips with a documented `pl-f17e` follow-up reference;
 *     the dialect-aware repo layer will light up the path under pg.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import {
	buildPreviewProjectFixture,
	ensureProject,
	fetchEvents,
	loginAndIssueCookie,
	proxyRequest,
	waitForPreviewState,
	waitForRunTerminal,
} from "./20-preview.helpers.ts";

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly previewState: "starting" | "live" | "failed" | "torn-down" | null;
	readonly previewPort: number | null;
	readonly previewFailureMessage: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

/** Generous: the reap path runs branch_push (best-effort, skipped on push
 *  failure), then pr_open (best-effort, skipped without GITHUB_TOKEN),
 *  then preview_launch which spawns the sidecar and probes readiness for
 *  up to 60s. */
const LIVE_PREVIEW_TIMEOUT_MS = 90_000;

const PREVIEW_HOST = "preview.warren.acceptance";

export const scenario: Scenario = {
	id: "20",
	title:
		"Preview environments — happy path + idle-TTL eviction (sqlite, Linux only; macOS skip per mx-1d31f0)",
	// Each variant boots its own warren+burrow; the supervisor lifecycle
	// hook isn't needed, but we use the harness's in-proc launcher (the
	// compose launcher doesn't expose the env-knob injection variant B
	// needs).
	modes: ["in-proc"],
	async run(ctx) {
		if (process.platform === "darwin") {
			skipScenario(
				"preview scenarios require burrow's Linux-only bwrap inbound-port-forwarding " +
					"(mx-1d31f0 / burrow inbound-forward.ts): Seatbelt doesn't isolate the network " +
					"namespace and the host port the allocator hands out has no listener.",
			);
		}
		const dialect = (process.env.WARREN_TEST_DIALECT ?? "sqlite").trim().toLowerCase();
		if (dialect === "postgres" || dialect === "postgresql") {
			skipScenario(
				"preview port allocator + eviction worker are sqlite-only today (mx-b82a55); " +
					"the pg path lights up under the R-13 dialect-aware repo follow-up (pl-f17e). " +
					"This scenario re-passes once that's wired.",
			);
		}

		await runVariantA(ctx);
		await runVariantB(ctx);
	},
};

/* ------------------------------------------------------------------ */
/* Variant A — happy path                                              */
/* ------------------------------------------------------------------ */

async function runVariantA(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20: variant A (happy path)");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20a-"));
	const sample = await buildPreviewProjectFixture({
		ctx,
		scenarioRoot: variantRoot,
		variantTag: "a",
	});

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				// Long enough that the proxy 200/401 assertions don't race
				// the eviction worker; variant B owns the eviction path.
				WARREN_PREVIEW_HOST: PREVIEW_HOST,
				WARREN_PREVIEW_IDLE_TTL: "30m",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "10000",
			},
		});
		ctx.logger.info(`scenario-20A: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20 variant-A: preview happy-path",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20A: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		assertTrue(
			typeof live.previewPort === "number" && live.previewPort > 0,
			`preview_port populated on live preview (got ${JSON.stringify(live.previewPort)})`,
		);

		// The launch sub-step emits `preview_launched` once it observes a
		// 2xx readiness response; assert it lands and carries the allocated
		// port so reap event ordering stays observable.
		const events = await fetchEvents(http, runId);
		const launched = events.find((e) => e.kind === "preview_launched");
		if (launched === undefined) {
			throw new AcceptanceError(
				`expected a preview_launched event on run ${runId}; saw kinds=[${events
					.map((e) => e.kind)
					.join(", ")}]`,
			);
		}
		const launchedPort = (launched.payload as { port?: unknown } | null)?.port;
		assertEqual(
			launchedPort,
			live.previewPort,
			"preview_launched.payload.port matches the run row's preview_port",
		);

		// Proxy preamble: missing cookie → 401, login → 302+Set-Cookie,
		// replay with cookie → 200 with the sidecar's response body.
		const previewHostHeader = `run-${runId}.${PREVIEW_HOST}`;
		const noCookie = await proxyRequest({
			warrenUrl: handle.warrenUrl,
			hostHeader: previewHostHeader,
			path: "/",
		});
		if (noCookie.status !== 401) {
			throw new AcceptanceError(
				`proxy without cookie: expected 401, got ${noCookie.status} body=${noCookie.bodySnippet}`,
			);
		}

		const cookie = await loginAndIssueCookie({
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			runId,
			previewHost: PREVIEW_HOST,
		});

		const withCookie = await proxyRequest({
			warrenUrl: handle.warrenUrl,
			hostHeader: previewHostHeader,
			path: "/",
			cookie,
		});
		if (withCookie.status !== 200) {
			throw new AcceptanceError(
				`proxy with cookie: expected 200, got ${withCookie.status} body=${withCookie.bodySnippet}`,
			);
		}
		// python3 -m http.server emits a directory index for `/`; assert
		// that it carries the marker file we committed so an accidental
		// upstream mis-route (e.g. proxy routing to a sibling port) fails
		// the assertion rather than silently passing on any 200.
		assertTrue(
			withCookie.bodySnippet.includes("preview-ok"),
			`expected proxied 200 to include 'preview-ok' marker, got ${JSON.stringify(
				withCookie.bodySnippet,
			)}`,
		);

		// Cleanup: manual teardown so the eviction worker doesn't have to
		// chase the sidecar after the variant's warren is killed.
		try {
			await http.request("POST", `/runs/${encodeURIComponent(runId)}/preview/teardown`, {
				body: { actor: "scenario-20A-cleanup" },
			});
		} catch {
			// Best-effort.
		}
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Variant B — idle-TTL eviction                                       */
/* ------------------------------------------------------------------ */

async function runVariantB(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20: variant B (idle-TTL eviction)");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20b-"));
	const sample = await buildPreviewProjectFixture({
		ctx,
		scenarioRoot: variantRoot,
		variantTag: "b",
	});

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				WARREN_PREVIEW_HOST: PREVIEW_HOST,
				// 2s idle TTL with a 500ms tick → eviction fires within
				// ~2.5s of the row reaching live (and no proxy hits land,
				// so the idle clock anchors to preview_started_at).
				WARREN_PREVIEW_IDLE_TTL: "2s",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "500",
			},
		});
		ctx.logger.info(`scenario-20B: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20 variant-B: idle-TTL eviction",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20B: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		const livePort = live.previewPort;
		assertTrue(
			typeof livePort === "number" && livePort > 0,
			`preview_port populated when live (got ${JSON.stringify(livePort)})`,
		);

		// Critical: NO proxy requests in variant B. The idle clock falls
		// back to preview_started_at so eviction fires deterministically
		// 2s after the launcher persists the live transition.
		const evicted = await waitForPreviewState(http, runId, "torn-down", 15_000);
		assertEqual(
			evicted.previewPort,
			null,
			"port released back to the allocator on idle eviction (preview_port=null)",
		);

		const events = await fetchEvents(http, runId);
		const evictionEvent = events.find((e) => e.kind === "preview_evicted");
		if (evictionEvent === undefined) {
			throw new AcceptanceError(
				`expected a preview_evicted event on run ${runId}; saw kinds=[${events
					.map((e) => e.kind)
					.join(", ")}]`,
			);
		}
		const payload = evictionEvent.payload as {
			reason?: unknown;
			port?: unknown;
			previousState?: unknown;
		} | null;
		assertEqual(
			payload?.reason,
			"idle_ttl",
			"preview_evicted.payload.reason is 'idle_ttl' (not max_lifetime or lru)",
		);
		assertEqual(
			payload?.port,
			livePort,
			"preview_evicted.payload.port carries the port the allocator just released",
		);
		assertEqual(
			payload?.previousState,
			"live",
			"preview_evicted.payload.previousState was 'live' before the worker flipped it",
		);
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}
