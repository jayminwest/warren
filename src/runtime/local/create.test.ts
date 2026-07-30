/**
 * `LocalProvider.create()` — the two-call-collapsed dispatch over burrow
 * (pl-829f step 8). These tests drive the real body against the established
 * warren burrow-client fake (a `fetch` stub wrapped in a real `BurrowClient`,
 * see `src/runs/spawn/test-helpers.ts`) so the seam is exercised end-to-end
 * with no real socket: the two burrow calls, their mapped params, the
 * provider-computed callback URL, the RunHandle mapping, and
 * cleanup-on-partial-failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import {
	type BurrowFetchPlan,
	makeBurrowClient,
	makePool,
	setupRepos,
} from "../../runs/spawn/test-helpers.ts";
import type { RunSpec } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import { LocalProvider } from "./provider.ts";

let openDb: WarrenDb | null = null;

afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function repos(): Promise<Repos> {
	const { db, repos } = await setupRepos();
	openDb = db;
	return repos;
}

function newSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_domain0001",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_domain0001",
		baseBranch: "main",
		hostClonePathHint: "/data/projects/x/y",
		runtimeId: "claude-code",
		prompt: "system\n\n---\n\ndo the thing",
		metadata: { frontmatter: { model: "claude" } },
		mode: "batch",
		network: "restricted",
		seedFiles: [{ path: ".warren/agent.json", contents: "{}" }],
		env: { PLOT_ID: "pl_1", WARREN_QUALITY_GATE: "verify" },
		...overrides,
	};
}

/** Provider deps around a fake pool with the synthetic `local` worker. */
async function localProvider(
	plan: BurrowFetchPlan = {},
	serverEnv: EnvLike = {},
): Promise<{ provider: LocalProvider; calls: ReturnType<typeof makeBurrowClient>["calls"] }> {
	const r = await repos();
	const { client, calls } = makeBurrowClient(plan);
	const pool = await makePool(r, client);
	const provider = new LocalProvider({ burrowClient: () => pool, serverEnv });
	return { provider, calls };
}

describe("LocalProvider.create", () => {
	test("collapses burrowsUp + runs.create into two ordered, mapped calls", async () => {
		const { provider, calls } = await localProvider();
		await provider.create(newSpec());

		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /burrows",
			"POST /burrows/bur_aaaaaaaaaaaa/runs",
		]);

		const up = calls[0]?.body as Record<string, unknown>;
		expect(up.projectRoot).toBe("/data/projects/x/y"); // hostClonePathHint → projectRoot
		expect(up.originUrl).toBe("https://github.com/o/r.git");
		expect(up.agents).toEqual(["claude-code"]); // runtimeId → agents[]
		expect(up.branch).toBe("warren/run_domain0001");
		expect(up.baseBranch).toBe("main"); // spec.baseBranch → baseBranch
		expect(up.network).toBe("restricted");
		expect(up.seed).toEqual({ files: [{ path: ".warren/agent.json", contents: "{}" }] });

		const create = calls[1]?.body as Record<string, unknown>;
		expect(create.agentId).toBe("claude-code"); // runtimeId → agentId
		expect(create.prompt).toBe("system\n\n---\n\ndo the thing"); // not re-composed
		expect(create.metadata).toEqual({ frontmatter: { model: "claude" } });
	});

	test("maps burrow responses onto the opaque RunHandle", async () => {
		const { provider } = await localProvider();
		const handle = await provider.create(newSpec());
		expect(handle).toEqual({
			runId: "run_domain0001", // spec.runId, not a burrow id
			sandboxId: "bur_aaaaaaaaaaaa", // burrow.id
			providerRunId: "run_zzzzzzzzzzzz", // burrowRun.id
		});
	});

	test("computes a provider-owned loopback callback URL from server env", async () => {
		const { provider, calls } = await localProvider({}, { WARREN_BIND_PORT: "9099" });
		await provider.create(newSpec({ env: { WARREN_API_TOKEN: "tok", PLOT_ID: "pl_1" } }));
		const env = (calls[0]?.body as { env: Record<string, string> }).env;
		// provider-owned, derived from serverEnv — NOT passed in on domain env
		expect(env.WARREN_API_URL).toBe("http://localhost:9099");
	});

	test("omits the callback URL when the domain supplied no token", async () => {
		const { provider, calls } = await localProvider({}, { WARREN_BIND_PORT: "9099" });
		await provider.create(newSpec({ env: { PLOT_ID: "pl_1" } }));
		const env = (calls[0]?.body as { env: Record<string, string> }).env;
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("omits the callback URL when warren is bound to a unix socket only", async () => {
		const { provider, calls } = await localProvider({}, { WARREN_BIND_SOCKET: "/run/w.sock" });
		await provider.create(newSpec({ env: { WARREN_API_TOKEN: "tok" } }));
		const env = (calls[0]?.body as { env: Record<string, string> }).env;
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("merges domain env with provider plumbing (provider keys win)", async () => {
		const { provider, calls } = await localProvider({}, { WARREN_BIND_PORT: "8080" });
		await provider.create(
			newSpec({
				env: {
					PLOT_ID: "pl_1",
					PLOT_ACTOR: "agent:x:run_domain0001",
					WARREN_QUALITY_GATE: "verify",
					WARREN_API_TOKEN: "tok",
				},
			}),
		);
		const env = (calls[0]?.body as { env: Record<string, string> }).env;
		// domain coordination + secrets preserved
		expect(env.PLOT_ID).toBe("pl_1");
		expect(env.PLOT_ACTOR).toBe("agent:x:run_domain0001");
		expect(env.WARREN_QUALITY_GATE).toBe("verify");
		expect(env.WARREN_API_TOKEN).toBe("tok");
		// provider-owned filesystem-layout + callback plumbing added
		expect(env.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
		expect(env.WARREN_API_URL).toBe("http://localhost:8080");
	});

	test("forwards a non-default baseBranch so the workspace branch is cut from it", async () => {
		const { provider, calls } = await localProvider();
		await provider.create(newSpec({ baseBranch: "release/2.0" }));
		const up = calls[0]?.body as Record<string, unknown>;
		// burrow's POST /burrows honors baseBranch: `git worktree add -b <branch>
		// <baseBranch>`, so the run's branch is cut from release/2.0, not main.
		expect(up.baseBranch).toBe("release/2.0");
	});

	test("forwards the concrete network intent verbatim", async () => {
		const { provider, calls } = await localProvider();
		await provider.create(newSpec({ network: "open" }));
		expect((calls[0]?.body as Record<string, unknown>).network).toBe("open");
	});

	test("omits the seed payload when there are no seed files", async () => {
		const { provider, calls } = await localProvider();
		await provider.create(newSpec({ seedFiles: [] }));
		expect((calls[0]?.body as Record<string, unknown>).seed).toBeUndefined();
	});

	test("on partial failure destroys the burrow and rethrows the original error", async () => {
		const { provider, calls } = await localProvider({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "dispatch boom" } },
		});
		await expect(provider.create(newSpec())).rejects.toThrow(/dispatch boom/);
		// burrowsUp succeeded, runs.create failed → best-effort destroy of the burrow
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /burrows",
			"POST /burrows/bur_aaaaaaaaaaaa/runs",
			"DELETE /burrows/bur_aaaaaaaaaaaa",
		]);
	});

	test("a destroy failure during cleanup does not mask the original error", async () => {
		const { provider } = await localProvider({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "dispatch boom" } },
			destroyStatus: 500,
			destroyBody: { error: { code: "internal_error", message: "destroy boom" } },
		});
		await expect(provider.create(newSpec())).rejects.toThrow(/dispatch boom/);
	});

	test("rejects a RunSpec with no hostClonePathHint before any burrow call", async () => {
		const { provider, calls } = await localProvider();
		await expect(provider.create(newSpec({ hostClonePathHint: undefined }))).rejects.toThrow(
			RuntimeProviderError,
		);
		expect(calls).toHaveLength(0);
	});

	test("resolves the sole worker when the pool has no synthetic `local` entry", async () => {
		const r = await repos();
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(r, client, "worker-a"); // non-`local` name
		const provider = new LocalProvider({ burrowClient: () => pool });
		const handle = await provider.create(newSpec());
		expect(handle.sandboxId).toBe("bur_aaaaaaaaaaaa");
		expect(calls[0]?.path).toBe("/burrows");
	});
});
