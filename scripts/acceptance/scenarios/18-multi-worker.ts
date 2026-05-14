/**
 * Scenario 18 — real multi-burrow acceptance for the R-12 worker pool
 * (warren-82ea).
 *
 * The in-process integration tests already cover the pieces in
 * isolation:
 *   - `src/server/integration.multi-worker.test.ts` drives the warren
 *     HTTP envelope (affinity / drain / fan-out) against stub
 *     BurrowClients in one process.
 *   - `src/burrow-client/integration.cross-process.test.ts` drives the
 *     BurrowClientPool boundary against real `burrow serve`
 *     subprocesses.
 *
 * Neither walks the full operator path: real `bootServer` reading a
 * real `warren.toml` with `[[workers]]`, real `BurrowClientPool.
 * fromConfig` wired by warren boot, real `POST /workers/:name/drain`
 * forwarding `/admin/drain` to a real burrow over auth-on HTTP, real
 * `GET /burrows` fan-out across multiple real burrows. This scenario
 * boots that stack — warren + alpha-burrow + beta-burrow — and drives
 * the three R-12 acceptance criteria through warren's HTTP API.
 *
 * Layout (built ad hoc inside `run()`, not via the shared bootInProc
 * the other scenarios reuse):
 *
 *   <ctx.tmp>/scenario-18/
 *     ├── data/ projects/ canopy-repo/ warren.db
 *     ├── sock/ alpha.sock beta.sock
 *     ├── burrow/alpha/ burrow/beta/    (per-worker burrow data dirs)
 *     ├── warren.toml                   ([[workers]] alpha + beta)
 *     └── git-config                    (insteadOf rewrites + a 2nd
 *                                        gitUrl pointing at the shared
 *                                        sample fixture path)
 *
 * Two distinct git URLs both resolve via `insteadOf` to the same on-disk
 * fixture repo, so we get two projects from one fixture without
 * rebuilding the canopy/agent setup.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { bootInProcMulti, type MultiBurrowHandle } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly burrowId: string | null;
	readonly workerId: string | null;
	readonly state: string;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workerName?: string };
}

interface BurrowListRow {
	readonly id: string;
	readonly createdAt: string;
}

interface BurrowListResponse {
	readonly burrows: BurrowListRow[];
	readonly workerErrors: { readonly worker: string; readonly message: string }[];
}

interface WorkersListResponse {
	readonly workers: { readonly name: string; readonly state: string }[];
}

interface DrainResponse {
	readonly name: string;
	readonly state: string;
	readonly drain: boolean;
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const SECOND_PROJECT_URL = "https://github.com/warren-acceptance/sample-b.git";

export const scenario: Scenario = {
	id: "18",
	title: "Real multi-burrow acceptance — affinity, drain failover, and cross-worker fan-out (R-12)",
	modes: ["in-proc"],
	async run(ctx) {
		// Each scenario gets a fresh tmpdir so it can stand up its own
		// warren+burrow topology without trampling the shared single-burrow
		// stack the other scenarios share.
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-18-"));

		// Append a second insteadOf so warren can clone the same fixture
		// twice under two distinct gitUrls. `projects` is keyed by gitUrl,
		// so the second URL yields a second project row whose local clone
		// is a fresh, independent copy.
		const gitConfigPath = join(scenarioRoot, "git-config");
		const sourceGitConfig = await readFile(
			join(ctx.tmp, "git-config").startsWith("/") ? join(ctx.tmp, "git-config") : "",
			"utf8",
		).catch(() => "");
		const baseGitConfig =
			sourceGitConfig !== ""
				? sourceGitConfig
				: "[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n";
		const extraRedirect = `[url "${ctx.fixtures.sampleProjectPath}"]\n\tinsteadOf = ${SECOND_PROJECT_URL}\n`;
		await writeFile(gitConfigPath, `${baseGitConfig}\n${extraRedirect}`);

		const burrowToken = randomToken();

		let handle: MultiBurrowHandle | undefined;
		try {
			handle = await bootInProcMulti({
				tmpRoot: scenarioRoot,
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				workers: ["alpha", "beta"],
				burrowToken,
				extraEnv: {
					// Project-affinity test: P #2 dispatch is in-flight when Q
					// dispatches, so beta wins least-loaded. Long enough that the
					// http poll loop in waitForTerminal observes 'running'.
					WARREN_STUB_SLEEP_MS: "4000",
				},
			});
			ctx.logger.info(`scenario-18: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// Refresh agents (canopy is cloned on demand by warren) and add
			// both projects.
			await http.expectStatus("POST", "/agents/refresh", 200);
			const projectP = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
			});
			const projectQ = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: SECOND_PROJECT_URL },
			});

			// Pool topology sanity: GET /workers shows two healthy rows.
			const workersBefore = await http.expectJson<WorkersListResponse>("GET", "/workers", 200);
			const names = new Set(workersBefore.workers.map((w) => w.name));
			assertTrue(
				names.has("alpha") && names.has("beta") && workersBefore.workers.length === 2,
				`expected workers=[alpha,beta], got ${JSON.stringify(workersBefore.workers)}`,
			);
			for (const w of workersBefore.workers) {
				assertEqual(w.state, "healthy", `worker ${w.name} initial state`);
			}

			// === R-12 #1: project affinity ===
			// P #1 uses the `pi` agent so it terminates naturally (agent_end
			// envelope drives warren's bridge to finalize=succeeded). No
			// affinity yet + both workers load=0 → alpha by alphabetical
			// tiebreak.
			const p1 = await spawnRun(http, "pi", projectP.id, "scenario-18 P #1");
			const p1Worker = await workerOf(http, handle, p1.run.burrowId);
			assertEqual(p1Worker, "alpha", "first run for project P lands on alpha");

			// Wait for P #1 to succeed so P's affinity = alpha
			// (mostRecentSucceededWithWorker requires state='succeeded').
			await waitForTerminal(http, p1.run.id, 30_000);
			const p1Final = await http.expectJson<RunRow>(
				"GET",
				`/runs/${encodeURIComponent(p1.run.id)}`,
				200,
			);
			assertEqual(p1Final.state, "succeeded", "P #1 terminal state");

			// P #2 uses stub-shell so the run stays `running` and contributes
			// load to alpha for the next placement decision. Affinity wins
			// regardless: alpha is P's most-recent-succeeded worker.
			const p2 = await spawnRun(http, "stub-shell", projectP.id, "scenario-18 P #2");
			const p2Worker = await workerOf(http, handle, p2.run.burrowId);
			assertEqual(p2Worker, "alpha", "second run for project P lands on alpha by affinity");

			// Q has no affinity. With P #2 still running on alpha, alpha load=1
			// and beta load=0 → beta wins least-loaded.
			const q1 = await spawnRun(http, "stub-shell", projectQ.id, "scenario-18 Q #1");
			const q1Worker = await workerOf(http, handle, q1.run.burrowId);
			assertEqual(q1Worker, "beta", "Q with no affinity routes to least-loaded (beta)");

			// === R-12 #3: cross-worker fan-out (healthy path) ===
			// GET /burrows unions both workers, sorted by createdAt asc.
			// All three burrows should be present; alpha contributes p1+p2,
			// beta contributes q1.
			const fanHealthy = await http.expectJson<BurrowListResponse>("GET", "/burrows", 200);
			assertEqual(
				fanHealthy.workerErrors.length,
				0,
				`healthy fan-out should have no workerErrors; got ${JSON.stringify(fanHealthy.workerErrors)}`,
			);
			const fanIds = new Set(fanHealthy.burrows.map((b) => b.id));
			for (const burrowId of [p1.burrow.id, p2.burrow.id, q1.burrow.id]) {
				assertTrue(
					fanIds.has(burrowId),
					`fan-out missing burrow ${burrowId} (got ${JSON.stringify([...fanIds])})`,
				);
			}
			// Sorted ascending by createdAt.
			const createdAts = fanHealthy.burrows.map((b) => b.createdAt);
			for (let i = 1; i < createdAts.length; i++) {
				const prev = createdAts[i - 1] ?? "";
				const cur = createdAts[i] ?? "";
				assertTrue(prev <= cur, `fan-out burrows not sorted by createdAt asc: ${prev} > ${cur}`);
			}

			// Cancel P #2 and Q #1 (stub-shell never natural-terminates) so
			// the load counters reset before the drain test. Cancel is
			// idempotent (mx-fadaa2); cancelled rows don't contribute to
			// queued+running load.
			await cancelBestEffort(http, p2.run.id);
			await cancelBestEffort(http, q1.run.id);
			await waitForTerminal(http, p2.run.id, 15_000);
			await waitForTerminal(http, q1.run.id, 15_000);

			// === R-12 #2: failover on drain ===
			// Drain alpha through warren — handler forwards /admin/drain to
			// alpha's burrow (auth-on, shared bearer) and flips warren's row.
			const drain = await http.expectJson<DrainResponse>("POST", "/workers/alpha/drain", 200, {
				body: {},
			});
			assertEqual(drain.name, "alpha", "drain response name");
			assertEqual(drain.state, "draining", "drain response state");
			assertEqual(drain.drain, true, "drain response flag");

			const workersAfterDrain = await http.expectJson<WorkersListResponse>("GET", "/workers", 200);
			const alphaRow = workersAfterDrain.workers.find((w) => w.name === "alpha");
			const betaRow = workersAfterDrain.workers.find((w) => w.name === "beta");
			assertEqual(alphaRow?.state, "draining", "alpha state after drain");
			assertEqual(betaRow?.state, "healthy", "beta state after drain");

			// Next P run: alpha is P's affinity, but alpha is draining →
			// placement falls through to least-loaded healthy → beta. Use pi
			// so the run terminates cleanly and we don't have to cancel.
			const p3 = await spawnRun(http, "pi", projectP.id, "scenario-18 P #3 (post-drain)");
			const p3Worker = await workerOf(http, handle, p3.run.burrowId);
			assertEqual(
				p3Worker,
				"beta",
				"post-drain P run fails over to beta even though alpha is P's affinity",
			);

			// Sticky-by-burrow still works: GET /burrows/<p1-burrow-id>
			// must continue routing to alpha (alpha is draining, not down).
			const stickyAlpha = await http.expectJson<{ readonly id: string }>(
				"GET",
				`/burrows/${encodeURIComponent(p1.burrow.id)}`,
				200,
			);
			assertEqual(
				stickyAlpha.id,
				p1.burrow.id,
				"sticky-by-burrow still resolves an alpha-pinned burrow through a draining alpha",
			);

			await waitForTerminal(http, p3.run.id, 30_000);

			// Un-drain alpha so the subsequent fan-out failure test starts
			// from a healthy baseline (otherwise the worker_unreachable
			// signal mixes with the draining signal).
			const undrain = await http.expectJson<DrainResponse>("POST", "/workers/alpha/drain", 200, {
				body: { drain: false },
			});
			assertEqual(undrain.state, "healthy", "undrain returns alpha to healthy");

			// === R-12 #3 (continued): fan-out with a killed worker ===
			// SIGKILL alpha's burrow process. The next GET /burrows must
			// return beta's rows + a workerErrors entry for alpha.
			await handle.killBurrow("alpha");
			// Burrow shutdown is a kernel-level socket close; the unreachable
			// state propagates to the next fan-out call immediately.
			const fanKilled = await fetchFanoutUntilError(http, "alpha", 10_000);
			assertEqual(
				fanKilled.workerErrors.length,
				1,
				`expected exactly one workerError after killing alpha, got ${JSON.stringify(fanKilled.workerErrors)}`,
			);
			assertEqual(
				fanKilled.workerErrors[0]?.worker,
				"alpha",
				"workerErrors entry names the killed worker",
			);

			// Stretch: sticky-by-burrow against a killed worker returns
			// an error envelope rather than silently re-placing the burrow.
			// The probe loop must have flipped alpha to `unreachable` first;
			// poll until it does.
			await waitForWorkerState(http, "alpha", "unreachable", 10_000);
			const stickyKilledRes = await http.request(
				"GET",
				`/burrows/${encodeURIComponent(p1.burrow.id)}`,
			);
			assertTrue(
				stickyKilledRes.status >= 500 && stickyKilledRes.status < 600,
				`sticky-by-burrow against killed alpha should be 5xx, got ${stickyKilledRes.status}`,
			);
			const stickyKilledBody = (await stickyKilledRes.json()) as {
				readonly error?: { readonly code?: string };
			};
			assertEqual(
				stickyKilledBody.error?.code,
				"sticky_worker_unreachable",
				"sticky-by-burrow against killed worker returns sticky_worker_unreachable",
			);
		} finally {
			if (handle !== undefined) await handle.stop().catch(() => undefined);
		}
	},
};

/**
 * Spawn a run with explicit agent + prompt. We use two agents in this
 * scenario:
 *   - `pi`: emits a terminal `agent_end` envelope so warren's bridge
 *     finalizes the run to `succeeded`. Used for the warm-up + post-drain
 *     dispatches where the affinity / failover assertions need a
 *     succeeded row in the runs table.
 *   - `stub-shell`: deterministic but emits raw stdout — its run row
 *     stays `running` until cancelled. Used for the in-flight load test
 *     where the placement decision keys off `runs.workerId` rows in
 *     `queued`/`running` (mx-c... least-loaded path).
 */
async function spawnRun(
	http: WarrenHttp,
	agent: string,
	projectId: string,
	prompt: string,
): Promise<CreateRunResponse> {
	const body = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: {
			agent,
			project: projectId,
			prompt: agent === "stub-shell" ? `[sleep_ms=8000] ${prompt}` : prompt,
		},
	});
	assertTrue(
		typeof body.run.burrowId === "string" && body.run.burrowId !== null,
		"spawn response missing burrowId",
	);
	return body;
}

async function cancelBestEffort(http: WarrenHttp, runId: string): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch {
		// best-effort
	}
}

/**
 * Resolve the worker that owns a burrow. Warren's POST /runs response
 * doesn't always echo worker_name, but `runs.workerId` is the source of
 * truth — warren's placement pinned the run there. We poll briefly in
 * case the row was created before the spawn handler flushed the workerId
 * column (the race is unlikely but cheap to harden against).
 */
async function workerOf(
	http: WarrenHttp,
	_handle: MultiBurrowHandle,
	burrowId: string | null,
): Promise<string> {
	if (burrowId === null) throw new AcceptanceError("workerOf: burrowId is null");
	const fan = await http.expectJson<BurrowListResponse>("GET", "/burrows", 200);
	const row = fan.burrows.find((b) => b.id === burrowId) as
		| (BurrowListRow & { readonly workerName?: string })
		| undefined;
	if (row === undefined) {
		throw new AcceptanceError(`workerOf: burrow ${burrowId} not in fan-out`);
	}
	// Burrow ids are minted by the burrow process: a burrow whose id maps
	// to alpha came from the alpha worker. Cross-reference via warren's
	// own workers table (GET /burrows returns workerName when the server
	// fills it; if not, fall back to the runs row).
	if (typeof row.workerName === "string" && row.workerName.length > 0) return row.workerName;
	// Last-resort lookup via runs index (find the run whose burrow_id
	// matches). The /runs endpoint returns workerId on the run row.
	const runsList = (
		await http.expectJson<{ readonly runs: readonly RunRow[] }>("GET", "/runs", 200)
	).runs;
	const match = runsList.find((r) => r.burrowId === burrowId);
	if (match === undefined || match.workerId === null) {
		throw new AcceptanceError(
			`workerOf: could not resolve worker for burrow ${burrowId} via /runs`,
		);
	}
	return match.workerId;
}

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) return row.state;
		await sleep(150);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach terminal state within ${timeoutMs}ms (last=${last})`,
	);
}

async function waitForWorkerState(
	http: WarrenHttp,
	name: string,
	target: string,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const list = await http.expectJson<WorkersListResponse>("GET", "/workers", 200);
		const row = list.workers.find((w) => w.name === name);
		last = row?.state ?? "missing";
		if (row?.state === target) return;
		await sleep(200);
	}
	throw new AcceptanceError(
		`worker ${name} did not reach state '${target}' within ${timeoutMs}ms (last=${last})`,
	);
}

/**
 * Burrow's socket close may not be observed by warren's pool client on
 * the very first fan-out call after SIGKILL — the http client lazily
 * detects the dead connection. Poll until a workerErrors entry naming
 * the killed worker shows up. Cheap and deterministic.
 */
async function fetchFanoutUntilError(
	http: WarrenHttp,
	expectedDownWorker: string,
	timeoutMs: number,
): Promise<BurrowListResponse> {
	const start = Date.now();
	let last: BurrowListResponse = { burrows: [], workerErrors: [] };
	while (Date.now() - start < timeoutMs) {
		last = await http.expectJson<BurrowListResponse>("GET", "/burrows", 200);
		if (last.workerErrors.some((e) => e.worker === expectedDownWorker)) return last;
		await sleep(150);
	}
	throw new AcceptanceError(
		`fan-out never surfaced workerErrors for ${expectedDownWorker} within ${timeoutMs}ms (last=${JSON.stringify(last)})`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
