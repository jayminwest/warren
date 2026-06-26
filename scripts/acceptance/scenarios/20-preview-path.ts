/**
 * Scenario 20-path — path-mode previews end-to-end
 * (R-19 / SPEC §11.L addendum, warren-7b3c / pl-f4ea step 8).
 *
 * Sibling of scenario 20 (subdomain mode). Locks down the path-mode
 * acceptance criterion (#2 on pl-f4ea): a fresh-install warren with no
 * `WARREN_PREVIEW_HOST` (and no wildcard DNS / wildcard cert) can
 * dispatch a run and serve a working preview at
 * `https://<warren-host>/p/<run-id>/`. This is the zero-domain
 * operator path the path-mode plan exists to enable.
 *
 * Boots its own warren+burrow stack with:
 *
 *   - `WARREN_PREVIEW_MODE=path`
 *   - **no** `WARREN_PREVIEW_HOST` — proves the proxy preamble + the
 *     login handshake both work when the operator has nothing but the
 *     warren origin to hand reviewers.
 *   - idle TTL big enough that eviction doesn't race the proxy assertions
 *     (the idle-TTL eviction path is mode-agnostic and stays the
 *     responsibility of scenario 20 variant B).
 *
 * Dispatches a stub run against a preview-enabled fixture and asserts:
 *
 *   1. Run reaches `succeeded`; `preview_state='live'`, `preview_port`
 *      assigned.
 *   2. Anonymous `GET <warrenUrl>/p/<runId>/` is rejected with 401 by
 *      the path-mode proxy preamble (cookie required).
 *   3. `GET /runs/<runId>/preview/login?token=…&redirect=…` returns 302
 *      with a `Set-Cookie: warren_preview_<runId>=…; Path=/` —
 *      per-run cookie name + root `Path` (warren-63e1) is what makes
 *      referer-based asset routing authenticate `/_next/static/...`
 *      sub-resource loads and isolates sibling-run sessions in the same
 *      browser (SPEC §11.L risk 4 mitigation).
 *   4. Authenticated `GET <warrenUrl>/p/<runId>/` returns 200, the body
 *      carries the upstream `preview-ok` marker (proves the proxy hit
 *      the sidecar, not a sibling port) AND the path-mode HTML
 *      rewriter injected `<base href="/p/<runId>/">` (proves the
 *      response-side transform from warren-ab3a fires in path mode).
 *   5. Referer-routed asset (warren-63e1): `GET <warrenUrl>/asset.txt`
 *      with `Referer: <warrenUrl>/p/<runId>/` AND the per-run cookie
 *      returns the sidecar's content for `/asset.txt` — proves the
 *      proxy preamble extracts the runId from `Referer` when the path
 *      itself doesn't start with `/p/<id>/`, and that the per-run
 *      `Path=/` cookie was actually shipped on the asset request.
 *
 * Skip conditions match scenario 20:
 *
 *   - **macOS** — burrow's bwrap-based inbound-port-forwarding (R-08)
 *     is Linux-only (mx-1d31f0).
 *   - **Postgres dialect** — the SPEC §11.L port allocator + eviction
 *     worker are sqlite-only today (mx-b82a55).
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
	type CreateRunResponse,
	ensureProject,
	fetchRaw,
	LIVE_PREVIEW_TIMEOUT_MS,
	loginAndIssueCookie,
	PREVIEW_ASSET_FILENAME,
	PREVIEW_ASSET_MARKER,
	PREVIEW_OK_MARKER,
	waitForPreviewState,
	waitForRunTerminal,
} from "./20-preview-path.helpers.ts";

export const scenario: Scenario = {
	id: "20-path",
	title:
		"Preview environments — path mode happy-path (sqlite, Linux only; macOS skip per mx-1d31f0)",
	// Boots its own warren+burrow with `WARREN_PREVIEW_MODE=path` set at
	// boot time; the compose launcher doesn't expose the env-knob
	// injection seam we need, so in-proc only.
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

		await runPathHappyPath(ctx);
	},
};

async function runPathHappyPath(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20-path: dispatch + path-mode proxy round-trip");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20p-"));
	const sample = await buildPreviewProjectFixture({ ctx, scenarioRoot: variantRoot });

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				// Path mode: WARREN_PREVIEW_HOST deliberately unset. The
				// fresh-install promise is that the operator needs nothing
				// beyond `fly deploy` + a warren API token.
				WARREN_PREVIEW_MODE: "path",
				WARREN_PREVIEW_IDLE_TTL: "30m",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "10000",
			},
		});
		ctx.logger.info(`scenario-20-path: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20-path: preview path-mode happy-path",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20-path: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		assertTrue(
			typeof live.previewPort === "number" && live.previewPort > 0,
			`preview_port populated on live preview (got ${JSON.stringify(live.previewPort)})`,
		);

		const previewPath = `/p/${runId}/`;

		// 1. Anonymous → 401. The path-mode proxy preamble matches
		//    /p/<runId>/ regardless of Host header (we hit the warren
		//    origin directly), runs cookie verification, and rejects when
		//    the cookie is absent.
		const noCookie = await fetchRaw(handle.warrenUrl, previewPath);
		if (noCookie.status !== 401) {
			throw new AcceptanceError(
				`path-mode proxy without cookie: expected 401, got ${noCookie.status} body=${noCookie.bodySnippet}`,
			);
		}

		// 2. Login handshake — assert 302 + per-run-named cookie at Path=/.
		const expectedCookieName = `warren_preview_${runId}`;
		const login = await loginAndIssueCookie({
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			runId,
			cookieName: expectedCookieName,
		});
		assertEqual(
			login.cookiePath,
			"/",
			"Set-Cookie scopes the path-mode cookie to Path=/ in path mode (warren-63e1: enables referer-based asset routing on every same-origin request)",
		);
		assertTrue(
			login.cookieDomain === undefined,
			`path-mode cookie must be host-only (no Domain attribute); got Domain=${JSON.stringify(login.cookieDomain)}`,
		);

		const cookieHeader = `${expectedCookieName}=${login.cookieValue}`;

		// 3. Authenticated → 200 with upstream marker AND injected <base>.
		const withCookie = await fetchRaw(handle.warrenUrl, previewPath, {
			cookie: cookieHeader,
		});
		if (withCookie.status !== 200) {
			throw new AcceptanceError(
				`path-mode proxy with cookie: expected 200, got ${withCookie.status} body=${withCookie.bodySnippet}`,
			);
		}
		assertTrue(
			withCookie.bodySnippet.includes(PREVIEW_OK_MARKER),
			`expected proxied 200 to include ${JSON.stringify(PREVIEW_OK_MARKER)} marker, got ${JSON.stringify(withCookie.bodySnippet)}`,
		);
		const expectedBase = `<base href="${previewPath}">`;
		assertTrue(
			withCookie.bodySnippet.includes(expectedBase),
			`expected path-mode HTML rewrite to inject ${JSON.stringify(expectedBase)}, got ${JSON.stringify(withCookie.bodySnippet)}`,
		);

		// 4. Referer-routed asset (warren-63e1): no /p/<id>/ in path, but
		//    Referer points at the preview page → proxy preamble routes the
		//    request to the sidecar and the per-run cookie at Path=/
		//    authenticates it.
		const assetReferer = `${handle.warrenUrl}${previewPath}`;
		const assetRes = await fetchRaw(handle.warrenUrl, `/${PREVIEW_ASSET_FILENAME}`, {
			cookie: cookieHeader,
			referer: assetReferer,
		});
		if (assetRes.status !== 200) {
			throw new AcceptanceError(
				`referer-routed asset GET /${PREVIEW_ASSET_FILENAME}: expected 200, got ${assetRes.status} body=${assetRes.bodySnippet}`,
			);
		}
		assertTrue(
			assetRes.bodySnippet.includes(PREVIEW_ASSET_MARKER),
			`expected referer-routed asset response to include ${JSON.stringify(PREVIEW_ASSET_MARKER)}, got ${JSON.stringify(assetRes.bodySnippet)}`,
		);

		// Cleanup: manual teardown so the eviction worker doesn't have to
		// chase the sidecar after this scenario's warren is killed.
		try {
			await http.request("POST", `/runs/${encodeURIComponent(runId)}/preview/teardown`, {
				body: { actor: "scenario-20-path-cleanup" },
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
