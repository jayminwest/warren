/**
 * Provider-neutral dispatch (warren-c42c). `spawnRun` routes EXCLUSIVELY
 * through `RuntimeProvider.create()`, so it must work against ANY backend the
 * `WARREN_RUNTIME` selector resolves — not just the burrow-backed
 * `LocalProvider`. These tests drive a fake, non-burrow provider (pod-shaped
 * handle ids, no burrow HTTP surface) to prove:
 *
 *   1. spawn hands the provider a neutral `RunSpec` (runId, originUrl, branch,
 *      runtimeId, prompt, seedFiles, network) and attaches the returned
 *      handle's `sandboxId` / `providerRunId` back onto the run row — with no
 *      assumption that those ids are burrow-shaped, so the K8s backend (pod
 *      name / pod uid) is served identically.
 *   2. a `create()` failure rolls the warren row back to
 *      `failed`/`never_started` the same way regardless of backend — the
 *      domain owns the row unwind, the provider owns the sandbox teardown.
 *
 * This file deliberately imports neither `../../burrow-client` nor
 * `@os-eco/burrow-cli`: the spawn path is backend-agnostic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type {
	RunHandle,
	RunSpec,
	RuntimeCapabilities,
	RuntimeProvider,
} from "../../runtime/contract.ts";
import { spawnRun } from "./index.ts";
import { setupRepos } from "./test-helpers.ts";

const K8S_CAPABILITIES: RuntimeCapabilities = {
	previewPorts: false,
	networkPolicy: "coarse",
	longLived: true,
	midRunSteering: false,
	enforcedResourceLimits: true,
	workspaceArchive: false,
	workspaceGc: false,
};

/** A non-burrow provider that records the neutral spec and returns a pod-shaped handle. */
function makeRecordingProvider(handle: Partial<RunHandle> = {}): {
	provider: RuntimeProvider;
	specs: RunSpec[];
} {
	const specs: RunSpec[] = [];
	const provider: RuntimeProvider = {
		capabilities: K8S_CAPABILITIES,
		async create(spec) {
			specs.push(spec);
			return {
				runId: spec.runId,
				sandboxId: handle.sandboxId ?? "warren-run-pod-abc",
				providerRunId: handle.providerRunId ?? "pod-uid-xyz",
			};
		},
		streamEvents() {
			throw new Error("streamEvents not exercised by spawn");
		},
		async status() {
			throw new Error("status not exercised by spawn");
		},
		async sendMessage() {
			throw new Error("sendMessage not exercised by spawn");
		},
		async cancel() {},
		async workspaceInfo() {
			throw new Error("workspaceInfo not exercised by spawn");
		},
		async finalize() {
			throw new Error("finalize not exercised by spawn");
		},
		async terminate() {
			throw new Error("terminate not exercised by spawn");
		},
	};
	return { provider, specs };
}

describe("spawnRun: provider-neutral dispatch (k8s-shaped backend)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("hands a neutral RunSpec to provider.create and attaches the pod-shaped handle ids", async () => {
		const { provider, specs } = makeRecordingProvider();
		const result = await spawnRun({
			repos,
			runtimeProvider: provider,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
		});

		// Exactly one seam call, carrying provider-neutral intent.
		expect(specs).toHaveLength(1);
		const spec = specs[0];
		if (spec === undefined) throw new Error("no RunSpec captured");
		expect(spec.runId).toBe(result.run.id);
		expect(spec.originUrl).toBe("https://github.com/x/y.git");
		expect(spec.baseBranch).toBe("main");
		expect(spec.branch).toContain(result.run.id);
		expect(spec.runtimeId).toBe("pi");
		expect(spec.prompt).toContain("do the thing");
		expect(spec.network).toBe("none");
		expect(spec.seedFiles.map((f) => f.path)).toContain(".canopy/agent.json");

		// The handle's ids are attached back onto the run row — pod name / pod uid,
		// not burrow ids. spawn makes no shape assumption.
		expect(result.burrow.id).toBe("warren-run-pod-abc");
		expect(result.burrowRun.id).toBe("pod-uid-xyz");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.burrowId).toBe("warren-run-pod-abc");
		expect(reread.burrowRunId).toBe("pod-uid-xyz");
		expect(reread.state).toBe("queued");
	});

	test("a provider.create failure rolls the warren row back to failed/never_started", async () => {
		const provider: RuntimeProvider = {
			capabilities: K8S_CAPABILITIES,
			async create() {
				throw new Error("pod admission rejected");
			},
			streamEvents() {
				throw new Error("unused");
			},
			async status() {
				throw new Error("unused");
			},
			async sendMessage() {
				throw new Error("unused");
			},
			async cancel() {},
			async workspaceInfo() {
				throw new Error("unused");
			},
			async finalize() {
				throw new Error("unused");
			},
			async terminate() {
				throw new Error("unused");
			},
		};

		await expect(
			spawnRun({
				repos,
				runtimeProvider: provider,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toThrow("pod admission rejected");

		const row = (await repos.runs.listAll())[0];
		expect(row?.state).toBe("failed");
		expect(row?.failureReason).toBe("never_started");
		// No sandbox id was ever attached (create threw) — the spawn_failed event
		// elides it, matching the burrow-backed rollback path.
		const ev = (await repos.events.listByRun(row?.id ?? "")).find((e) => e.kind === "spawn_failed");
		const payload = ev?.payloadJson as { message?: string; burrowId?: string };
		expect(payload?.message).toContain("pod admission rejected");
		expect(payload?.burrowId).toBeUndefined();
	});
});
