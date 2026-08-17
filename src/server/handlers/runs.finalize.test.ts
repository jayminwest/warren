import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { FinalizeResult } from "../../runtime/contract.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { FinalizeCoordinator } from "../../runtime/k8s/finalize-coordinator.ts";
import {
	IN_POD_FINALIZE_WIRE_VERSION,
	type InPodFinalizeIntent,
} from "../../runtime/k8s/finalize-wire.ts";
import { bearerAuth, NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * HTTP coverage for the K8s finalize callback (warren-0d35):
 *   GET  /runs/:id/finalize-intent  — serve the parked intent to the in-pod harness
 *   POST /runs/:id/finalize-result  — intake the collected FinalizeResult
 * The correlation/idempotency semantics live in `finalize-coordinator.test.ts`;
 * this file covers the route surface: auth gating, wire shape, validation, and
 * idempotent re-POST.
 */

function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

function sampleIntent(): Omit<InPodFinalizeIntent, "attemptId"> {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		branch: "warren/run_x",
		push: true,
		artifacts: ["mulch", "seeds"],
		commit: ["seeds"],
		baseBranch: "main",
	};
}

function sampleResult(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 2,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "seeds.closed", payload: { id: "warren-1" } }],
		artifacts: {},
		prBranch: "warren/run_x",
		stages: [{ stage: "branch_push", status: "ok" }],
	};
}

describe("finalize callback endpoints", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let coordinator: FinalizeCoordinator;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		coordinator = new FinalizeCoordinator();
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serveWith(auth = NO_AUTH): Promise<string> {
		const deps = await depsFor(repos, inertSandboxClient(), undefined, {
			finalizeCoordinator: coordinator,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("GET finalize-intent returns {intent:null} when none is parked", async () => {
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_x/finalize-intent`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ intent: null });
	});

	test("GET finalize-intent serves the parked intent with its attemptId", async () => {
		const parked = coordinator.register("run_x", sampleIntent());
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_x/finalize-intent`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { intent: InPodFinalizeIntent };
		expect(body.intent.attemptId).toBe(parked.attemptId);
		expect(body.intent.branch).toBe("warren/run_x");
		expect(body.intent.artifacts).toEqual(["mulch", "seeds"]);
	});

	test("POST finalize-result resolves the awaiting finalize and reports accepted", async () => {
		const parked = coordinator.register("run_x", sampleIntent());
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				version: IN_POD_FINALIZE_WIRE_VERSION,
				attemptId: parked.attemptId,
				result: sampleResult(),
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "accepted" });
		await expect(parked.result).resolves.toMatchObject({ pushed: true, commitsAhead: 2 });
	});

	test("POST finalize-result is idempotent on redelivery (duplicate)", async () => {
		const parked = coordinator.register("run_x", sampleIntent());
		const base = await serveWith();
		const body = JSON.stringify({
			version: IN_POD_FINALIZE_WIRE_VERSION,
			attemptId: parked.attemptId,
			result: sampleResult(),
		});
		const first = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(await first.json()).toEqual({ outcome: "accepted" });
		const second = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ outcome: "duplicate" });
	});

	test("POST finalize-result 400s on a malformed body", async () => {
		coordinator.register("run_x", sampleIntent());
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: IN_POD_FINALIZE_WIRE_VERSION, attemptId: "fin_x" }), // no result
		});
		expect(res.status).toBe(400);
	});

	test("POST finalize-result rejects an unsupported wire version", async () => {
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: 999, attemptId: "fin_x", result: sampleResult() }),
		});
		expect(res.status).toBe(400);
	});

	test("GET finalize-intent miss fires the recovery hook with the agent_exit hint (warren-5202)", async () => {
		const misses: { runId: string; hint: unknown }[] = [];
		const deps = await depsFor(repos, inertSandboxClient(), undefined, {
			finalizeCoordinator: coordinator,
		});
		handle = startServer(
			{
				...deps,
				finalizeRecovery: {
					onIntentMiss: (runId, hint) => {
						misses.push({ runId, hint });
					},
					drivenCount: () => 0,
				},
			},
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const base = tcpUrl(handle);

		const res = await fetch(`${base}/runs/run_x/finalize-intent?agent_exit=0`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ intent: null });
		expect(misses).toEqual([{ runId: "run_x", hint: { agentExitCode: 0 } }]);
	});

	test("GET finalize-intent with a parked intent does NOT fire the recovery hook", async () => {
		coordinator.register("run_x", sampleIntent());
		const misses: string[] = [];
		const deps = await depsFor(repos, inertSandboxClient(), undefined, {
			finalizeCoordinator: coordinator,
		});
		handle = startServer(
			{
				...deps,
				finalizeRecovery: {
					onIntentMiss: (runId) => {
						misses.push(runId);
					},
					drivenCount: () => 0,
				},
			},
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const res = await fetch(`${tcpUrl(handle)}/runs/run_x/finalize-intent?agent_exit=1`);
		expect(res.status).toBe(200);
		expect(misses).toEqual([]);
	});

	test("GET finalize-intent tolerates a malformed agent_exit (hint omitted, still 200)", async () => {
		const misses: { runId: string; hint: unknown }[] = [];
		const deps = await depsFor(repos, inertSandboxClient(), undefined, {
			finalizeCoordinator: coordinator,
		});
		handle = startServer(
			{
				...deps,
				finalizeRecovery: {
					onIntentMiss: (runId, hint) => {
						misses.push({ runId, hint });
					},
					drivenCount: () => 0,
				},
			},
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const res = await fetch(`${tcpUrl(handle)}/runs/run_x/finalize-intent?agent_exit=bogus`);
		expect(res.status).toBe(200);
		expect(misses).toEqual([{ runId: "run_x", hint: {} }]);
	});

	test("both routes are bearer-gated like every /runs route", async () => {
		coordinator.register("run_x", sampleIntent());
		const base = await serveWith(bearerAuth("s3cret"));

		const deniedGet = await fetch(`${base}/runs/run_x/finalize-intent`);
		expect(deniedGet.status).toBe(401);
		const deniedPost = await fetch(`${base}/runs/run_x/finalize-result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(deniedPost.status).toBe(401);

		const ok = await fetch(`${base}/runs/run_x/finalize-intent`, {
			headers: { authorization: "Bearer s3cret" },
		});
		expect(ok.status).toBe(200);
	});
});
