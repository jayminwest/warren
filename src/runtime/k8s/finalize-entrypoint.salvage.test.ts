/**
 * warren-cd3b: the in-pod salvage-before-exit windows. The pod's `emptyDir`
 * dies with the container, so BOTH loss paths must capture the run's committed
 * work before the entrypoint returns:
 *
 *   - no intent ever arrives (control-plane rollout severed the finalize loop)
 *     ⇒ bundle + POST, retried through the rollout (`salvageMaxWaitMs`);
 *   - the intent's branch push fails (push protection) ⇒ rescue-ref + bundle
 *     POST BEFORE the finalize result POST (which lets warren terminate the pod).
 */
import { describe, expect, test } from "bun:test";
import type { FinalizeFs, FinalizeGitRunner } from "./finalize-collect.ts";
import { type FinalizeHttp, runFinalizeEntrypoint } from "./finalize-entrypoint.ts";
import type { SalvageEnvelope } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION, type InPodFinalizeIntent } from "./finalize-wire.ts";

function fakeFs(files: Record<string, string> = {}): FinalizeFs {
	return {
		readFile: async (path) => {
			if (path in files) return files[path] as string;
			throw new Error(`ENOENT ${path}`);
		},
		readdir: async () => {
			throw new Error("ENOTDIR");
		},
	};
}

function fakeGit(
	script: Partial<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): { git: FinalizeGitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: FinalizeGitRunner = async (args) => {
		calls.push(args);
		const key = args[0] === "remote" ? `remote ${args[1]}` : (args[0] ?? "");
		const s = script[key] ?? {};
		return { exitCode: s.exitCode ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
	};
	return { git, calls };
}

function intent(over: Partial<InPodFinalizeIntent> = {}): InPodFinalizeIntent {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: "fin_abcdefghjkmn",
		branch: "warren/run_x",
		push: true,
		artifacts: [],
		commit: [],
		baseBranch: "main",
		gitToken: "push-tok",
		...over,
	};
}

const env = {
	WARREN_RUN_ID: "run_x",
	WARREN_API_URL: "http://warren:8080",
	WARREN_API_TOKEN: "tok",
	WARREN_WORKSPACE_PATH: "/ws",
	WARREN_BASE_BRANCH: "main",
	WARREN_BRANCH: "warren/run_x",
};

const salvageDeps = {
	readFileBytes: async () => new TextEncoder().encode("bundle-bytes"),
	rm: async () => {},
	sleep: async () => {},
	now: () => 0,
	log: () => {},
};

describe("runFinalizeEntrypoint salvage (warren-cd3b)", () => {
	test("no intent arrives ⇒ the bundle is POSTed to /salvage before returning false", async () => {
		const posted: { url: string; body: unknown }[] = [];
		const http: FinalizeHttp = {
			// Never an intent; the entrypoint's maxWaitMs is driven to the deadline
			// immediately via `now`. The credential re-mint endpoint answers 503
			// (warren mid-rollout) so the no-credential posture is preserved.
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async (url, _t, body) => {
				if (url.endsWith("/git-credential")) return { status: 503 };
				posted.push({ url, body });
				return { status: 200 };
			},
		};
		const { git, calls } = fakeGit();
		let clock = 0;
		const did = await runFinalizeEntrypoint(
			{ ...env, WARREN_FINALIZE_MAX_WAIT_MS: "1", WARREN_SALVAGE_MAX_WAIT_MS: "10" },
			{
				...salvageDeps,
				http,
				git,
				fs: fakeFs(),
				now: () => {
					clock += 5;
					return clock;
				},
			},
		);
		expect(did).toBe(false);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.url).toBe("http://warren:8080/runs/run_x/salvage");
		const body = posted[0]?.body as SalvageEnvelope;
		expect(body.trigger).toBe("no_intent");
		expect(body.bundleBase64).toBe(Buffer.from("bundle-bytes").toString("base64"));
		// No git credential exists in this window — no rescue push was attempted.
		expect(body.rescueRef).toBeNull();
		expect(calls.find((c) => c[0] === "push")).toBeUndefined();
		// The bundle range used the pod env's base branch.
		expect(calls.find((c) => c[0] === "bundle")?.[3]).toBe("main..HEAD");
	});

	test("warren-6016: the no_intent window authenticates the rescue push with the pod-carried WARREN_GIT_TOKEN", async () => {
		const posted: SalvageEnvelope[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async (url, _t, body) => {
				// The window-3 re-mint mints anonymously here, so the pod-carried
				// token remains the credential under test (warren-c9ac).
				if (url.endsWith("/git-credential")) return { status: 200, body: { gitToken: null } };
				posted.push(body as SalvageEnvelope);
				return { status: 200 };
			},
		};
		const { git, calls } = fakeGit({
			"remote get-url": { stdout: "https://github.com/acme/widgets.git" },
		});
		let clock = 0;
		const did = await runFinalizeEntrypoint(
			{
				...env,
				WARREN_GIT_TOKEN: "pod-tok",
				WARREN_FINALIZE_MAX_WAIT_MS: "1",
				WARREN_SALVAGE_MAX_WAIT_MS: "10",
			},
			{
				...salvageDeps,
				http,
				git,
				fs: fakeFs(),
				now: () => {
					clock += 5;
					return clock;
				},
			},
		);
		expect(did).toBe(false);
		// The rescue push ran against an origin re-authenticated with the pod token.
		const setUrls = calls.filter((c) => c[0] === "remote" && c[1] === "set-url");
		expect(setUrls[0]?.[3]).toContain("pod-tok");
		expect(setUrls[1]?.[3]).toBe("https://github.com/acme/widgets.git");
		expect(posted[0]?.rescueRef).toBe("warren/rescue/run_x");
		expect(posted[0]?.bundleBase64).not.toBeNull();
	});

	test("warren-c9ac: the no_intent window prefers a credential minted over the callback", async () => {
		const posted: SalvageEnvelope[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async (url, _t, body) => {
				if (url.endsWith("/git-credential")) {
					return { status: 200, body: { gitToken: "ghs_fresh" } };
				}
				posted.push(body as SalvageEnvelope);
				return { status: 200 };
			},
		};
		const { git, calls } = fakeGit({
			"remote get-url": { stdout: "https://github.com/acme/widgets.git" },
		});
		let clock = 0;
		const did = await runFinalizeEntrypoint(
			{
				...env,
				WARREN_GIT_TOKEN: "pod-tok",
				WARREN_FINALIZE_MAX_WAIT_MS: "1",
				WARREN_SALVAGE_MAX_WAIT_MS: "10",
			},
			{
				...salvageDeps,
				http,
				git,
				fs: fakeFs(),
				now: () => {
					clock += 5;
					return clock;
				},
			},
		);
		expect(did).toBe(false);
		// The rescue push re-authed origin with the FRESHLY MINTED token, not the
		// pod-carried one (the App-mode path — the mounted Secret is never trusted).
		const setUrls = calls.filter((c) => c[0] === "remote" && c[1] === "set-url");
		expect(setUrls[0]?.[3]).toContain("ghs_fresh");
		expect(setUrls[0]?.[3]).not.toContain("pod-tok");
		expect(posted[0]?.rescueRef).toBe("warren/rescue/run_x");
	});

	test("warren-6016: in the push_failed window the intent's short-lived token wins over the pod-carried one", async () => {
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async () => ({ status: 200 }),
		};
		// Every push fails (primary + rescue) so the token choice is observable on
		// the RESCUE push's origin re-authentication, not on success.
		const { git, calls } = fakeGit({
			push: { exitCode: 1, stderr: "declined" },
			"remote get-url": { stdout: "https://github.com/acme/widgets.git" },
		});
		const did = await runFinalizeEntrypoint(
			{ ...env, WARREN_GIT_TOKEN: "pod-tok" },
			{ ...salvageDeps, http, git, fs: fakeFs() },
		);
		expect(did).toBe(true);
		const setUrls = calls.filter((c) => c[0] === "remote" && c[1] === "set-url");
		// Both the primary and the rescue push re-authed with the INTENT token.
		for (const call of setUrls) {
			if (call[3] === "https://github.com/acme/widgets.git") continue; // restore
			expect(call[3]).toContain("push-tok");
			expect(call[3]).not.toContain("pod-tok");
		}
		expect(setUrls.length).toBeGreaterThan(0);
	});

	test("a failed branch push ⇒ salvage POSTs BEFORE the finalize result", async () => {
		const order: string[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async (url, _t, body) => {
				order.push(url);
				if (url.endsWith("/salvage")) {
					const b = body as SalvageEnvelope;
					expect(b.trigger).toBe("push_failed");
					expect(b.bundleBase64).not.toBeNull();
				}
				return { status: 200 };
			},
		};
		// The primary push is rejected (push protection); the rescue push rides the
		// same token and is rejected too — the bundle is what saves the run.
		const { git } = fakeGit({ push: { exitCode: 1, stderr: "remote: push declined" } });
		const did = await runFinalizeEntrypoint(env, {
			...salvageDeps,
			http,
			git,
			fs: fakeFs(),
		});
		expect(did).toBe(true);
		expect(order).toEqual([
			"http://warren:8080/runs/run_x/salvage",
			"http://warren:8080/runs/run_x/finalize-result",
		]);
	});

	test("a failed branch push with a successful rescue push reports the rescue ref", async () => {
		const bodies: SalvageEnvelope[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async (url, _t, body) => {
				if (url.endsWith("/salvage")) bodies.push(body as SalvageEnvelope);
				return { status: 200 };
			},
		};
		// First push (primary) fails; every later push (rescue) succeeds.
		let pushes = 0;
		const base = fakeGit();
		const git: FinalizeGitRunner = async (args, opts) => {
			if (args[0] === "push") {
				pushes += 1;
				if (pushes === 1) return { exitCode: 1, stdout: "", stderr: "declined" };
			}
			return base.git(args, opts);
		};
		const did = await runFinalizeEntrypoint(env, {
			...salvageDeps,
			http,
			git,
			fs: fakeFs(),
		});
		expect(did).toBe(true);
		expect(bodies[0]?.rescueRef).toBe("warren/rescue/run_x");
	});

	test("warren-985e: a zero-commit push with a DIRTY tree folds the work into a salvage commit and POSTs salvage before the result", async () => {
		const order: string[] = [];
		const bodies: SalvageEnvelope[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async (url, _t, body) => {
				order.push(url);
				if (url.endsWith("/salvage")) bodies.push(body as SalvageEnvelope);
				return { status: 200 };
			},
		};
		// The primary push LANDS but `main..HEAD` is empty and the tree is dirty
		// — the run died mid-work (provider_error) before its first commit.
		const { git, calls } = fakeGit({
			"rev-list": { stdout: "0" },
			status: { stdout: " M src/runtime/k8s/finalize-entrypoint.salvage.test.ts\n" },
		});
		const did = await runFinalizeEntrypoint(env, { ...salvageDeps, http, git, fs: fakeFs() });
		expect(did).toBe(true);
		// Salvage is captured BEFORE the result POST lets warren terminate the pod.
		expect(order).toEqual([
			"http://warren:8080/runs/run_x/salvage",
			"http://warren:8080/runs/run_x/finalize-result",
		]);
		expect(bodies[0]?.trigger).toBe("empty_push_dirty");
		// The dirty tree was folded into a warren bookkeeping commit (never
		// gated on the project's hooks), then captured both ways.
		// The commit rides the canonical bot-identity `-c` args, so `commit` is
		// not argv[0] (src/bot-identity.ts — never re-spelled inline).
		const commit = calls.find((c) => c.includes("commit"));
		expect(commit).toBeDefined();
		expect(commit).toContain("--no-verify");
		expect(calls.find((c) => c[0] === "add")).toEqual(["add", "-A"]);
		expect(bodies[0]?.rescueRef).toBe("warren/rescue/run_x");
		expect(bodies[0]?.bundleBase64).not.toBeNull();
		expect(calls.find((c) => c[0] === "bundle")?.[3]).toBe("main..HEAD");
	});

	test("warren-985e: a zero-commit push with a CLEAN tree skips salvage (a deliberate no-op)", async () => {
		const posted: string[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async (url) => {
				posted.push(url);
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "0" }, status: { stdout: "" } });
		const did = await runFinalizeEntrypoint(env, { ...salvageDeps, http, git, fs: fakeFs() });
		expect(did).toBe(true);
		expect(posted).toEqual(["http://warren:8080/runs/run_x/finalize-result"]);
	});

	test("a successful push skips salvage entirely", async () => {
		const posted: string[] = [];
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: intent() } }),
			post: async (url) => {
				posted.push(url);
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "1" } });
		const did = await runFinalizeEntrypoint(env, { ...salvageDeps, http, git, fs: fakeFs() });
		expect(did).toBe(true);
		expect(posted).toEqual(["http://warren:8080/runs/run_x/finalize-result"]);
	});

	test("the salvage POST retries through a rollout window until warren answers", async () => {
		let postCalls = 0;
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async () => {
				postCalls += 1;
				// The old control plane is gone; the new one answers on attempt 3.
				if (postCalls < 3) throw new Error("Unable to connect");
				return { status: 200 };
			},
		};
		const { git } = fakeGit();
		let clock = 0;
		const did = await runFinalizeEntrypoint(
			{ ...env, WARREN_FINALIZE_MAX_WAIT_MS: "1", WARREN_SALVAGE_MAX_WAIT_MS: "1000" },
			{
				...salvageDeps,
				http,
				git,
				fs: fakeFs(),
				now: () => {
					clock += 5;
					return clock;
				},
			},
		);
		expect(did).toBe(false);
		expect(postCalls).toBe(3);
	});
});
