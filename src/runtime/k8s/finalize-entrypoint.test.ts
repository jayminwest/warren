import { describe, expect, test } from "bun:test";
import { DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS } from "../../runs/watchdog.ts";
import {
	collectFinalizeResult,
	collectMulchDelta,
	collectPlansDelta,
	collectSeedsDelta,
	countJsonlRecords,
	type FinalizeFs,
	type FinalizeGitRunner,
} from "./finalize-collect.ts";
import {
	DEFAULT_FINALIZE_MAX_WAIT_MS,
	extractIntent,
	type FinalizeHttp,
	parseFinalizeEntrypointEnv,
	pollForIntent,
	postResultWithRetry,
	runFinalizeEntrypoint,
} from "./finalize-entrypoint.ts";
import {
	IN_POD_FINALIZE_WIRE_VERSION,
	type InPodFinalizeIntent,
	validateFinalizeResult,
} from "./finalize-wire.ts";

/** In-memory fs seam: `files` maps absolute paths → body; `dirs` maps dir → names. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FinalizeFs {
	return {
		readFile: async (path) => {
			if (path in files) return files[path] as string;
			throw new Error(`ENOENT ${path}`);
		},
		readdir: async (path) => {
			if (path in dirs) return dirs[path] as string[];
			throw new Error(`ENOTDIR ${path}`);
		},
	};
}

/** Git seam recording argv, returning scripted `{exitCode,stdout,stderr}` by first arg. */
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
		artifacts: ["mulch", "seeds", "plans"],
		commit: ["seeds"],
		baseBranch: "main",
		...over,
	};
}

describe("parseFinalizeEntrypointEnv", () => {
	test("parses required + defaulted env", () => {
		const env = parseFinalizeEntrypointEnv({
			WARREN_RUN_ID: "run_x",
			WARREN_API_URL: "http://warren.svc:8080/",
			WARREN_API_TOKEN: "tok",
		});
		expect(env.runId).toBe("run_x");
		expect(env.apiUrl).toBe("http://warren.svc:8080"); // trailing slash stripped
		expect(env.workspacePath).toBe("/workspace");
		expect(env.pollIntervalMs).toBe(2_000);
	});

	test("throws on a missing required var", () => {
		expect(() => parseFinalizeEntrypointEnv({ WARREN_RUN_ID: "run_x" })).toThrow(/WARREN_API_URL/);
	});

	test("warren-6016: the pod-carried git token resolves WARREN_GIT_TOKEN then GITHUB_TOKEN", () => {
		const required = {
			WARREN_RUN_ID: "run_x",
			WARREN_API_URL: "http://warren:8080",
			WARREN_API_TOKEN: "tok",
		};
		expect(parseFinalizeEntrypointEnv(required).gitToken).toBeUndefined();
		expect(
			parseFinalizeEntrypointEnv({ ...required, WARREN_GIT_TOKEN: " pod-tok " }).gitToken,
		).toBe("pod-tok");
		// GITHUB_TOKEN is the fallback only — a set WARREN_GIT_TOKEN wins.
		expect(parseFinalizeEntrypointEnv({ ...required, GITHUB_TOKEN: "gh" }).gitToken).toBe("gh");
		expect(
			parseFinalizeEntrypointEnv({ ...required, WARREN_GIT_TOKEN: "pod", GITHUB_TOKEN: "gh" })
				.gitToken,
		).toBe("pod");
		expect(
			parseFinalizeEntrypointEnv({ ...required, WARREN_GIT_TOKEN: "  ", GITHUB_TOKEN: "" })
				.gitToken,
		).toBeUndefined();
	});
});

describe("countJsonlRecords", () => {
	test("counts non-empty lines", () => {
		expect(countJsonlRecords('{"a":1}\n{"b":2}\n\n')).toBe(2);
		expect(countJsonlRecords("")).toBe(0);
	});
});

describe("artifact-delta collection (workspace-truth)", () => {
	test("collectMulchDelta reads every expertise file with its verbatim body", async () => {
		const fs = fakeFs(
			{
				"/ws/.mulch/expertise/build.jsonl": '{"id":"a"}\n{"id":"b"}\n',
				"/ws/.mulch/expertise/ci.jsonl": '{"id":"c"}\n',
			},
			{ "/ws/.mulch/expertise": ["build.jsonl", "ci.jsonl", "README.md"] },
		);
		const d = await collectMulchDelta("/ws", fs);
		expect(d.files.map((f) => f.path)).toEqual([
			".mulch/expertise/build.jsonl",
			".mulch/expertise/ci.jsonl",
		]);
		expect(d.files[0]?.mergedBody).toBe('{"id":"a"}\n{"id":"b"}\n');
		expect(d.counts.appended).toBe(3);
		expect(d.counts.updated).toBe(0);
	});

	test("collectMulchDelta is empty when .mulch/expertise is absent", async () => {
		const d = await collectMulchDelta("/ws", fakeFs({}));
		expect(d).toEqual({ version: 1, files: [], counts: { updated: 0, skipped: 0, appended: 0 } });
	});

	test("collectSeedsDelta carries the workspace issues body; counts stay 0", async () => {
		const fs = fakeFs({ "/ws/.seeds/issues.jsonl": '{"id":"warren-1"}\n' });
		const d = await collectSeedsDelta("/ws", fs);
		expect(d.files[0]?.mergedBody).toBe('{"id":"warren-1"}\n');
		expect(d.counts.closed).toBe(0);
		expect(d.counts.created).toBe(0);
		expect(d.files[0]?.path).toBe(".seeds/issues.jsonl");
	});

	test("collectSeedsDelta files is empty when the file is absent", async () => {
		const d = await collectSeedsDelta("/ws", fakeFs({}));
		expect(d.files).toEqual([]);
	});

	test("collectPlansDelta counts appended plan records", async () => {
		const fs = fakeFs({ "/ws/.seeds/plans.jsonl": '{"id":"pl-1"}\n{"id":"pl-2"}\n' });
		const d = await collectPlansDelta("/ws", fs);
		expect(d.counts.appended).toBe(2);
		expect(d.files[0]?.mergedBody).toContain("pl-1");
	});
});

describe("collectFinalizeResult", () => {
	test("pushes, counts commits-ahead, and assembles a contract-shaped result", async () => {
		const fs = fakeFs(
			{
				"/ws/.seeds/plans.jsonl": '{"id":"pl-1"}\n',
				"/ws/.seeds/issues.jsonl": '{"id":"warren-1"}\n',
			},
			{ "/ws/.mulch/expertise": ["build.jsonl"] },
		);
		fs.readFile = (
			(orig) => (path: string) =>
				path === "/ws/.mulch/expertise/build.jsonl" ? Promise.resolve('{"id":"a"}\n') : orig(path)
		)(fs.readFile);
		const { git, calls } = fakeGit({
			"remote get-url": { stdout: "https://github.com/x/y.git" },
			"rev-list": { stdout: "4" },
		});

		const r = await collectFinalizeResult(intent({ gitToken: "ghp_tok" }), "/ws", { fs, git });

		expect(r.pushed).toBe(true);
		expect(r.commitsAhead).toBe(4);
		expect(r.emptyPush).toBe(false);
		expect(r.prBranch).toBe("warren/run_x");
		expect(r.workspacePlansBody).toBe('{"id":"pl-1"}\n');
		expect(r.artifacts.mulch?.files[0]?.path).toBe(".mulch/expertise/build.jsonl");
		expect(r.artifacts.seeds?.files[0]?.mergedBody).toBe('{"id":"warren-1"}\n');
		// The push authenticated origin then restored it.
		const argv = calls.map((c) => c.join(" "));
		expect(argv).toContain(
			"remote set-url origin https://x-access-token:ghp_tok@github.com/x/y.git",
		);
		expect(argv).toContain("push origin HEAD:warren/run_x");
		expect(argv).toContain("remote set-url origin https://github.com/x/y.git"); // restore
		// Bookkeeping commits are skipped in-pod (no clone to union against).
		const skipped = r.stages.filter((s) => s.status === "skipped").map((s) => s.stage);
		expect(skipped).toContain("seeds_commit");
	});

	test("push:false skips the push + count and produces empty-push=false", async () => {
		const { git } = fakeGit();
		const r = await collectFinalizeResult(intent({ push: false }), "/ws", { fs: fakeFs({}), git });
		expect(r.pushed).toBe(false);
		expect(r.commitsAhead).toBeNull();
		expect(r.stages.find((s) => s.stage === "branch_push")?.status).toBe("skipped");
	});

	test("a failed push records the failure and skips the count", async () => {
		const { git } = fakeGit({ push: { exitCode: 1, stderr: "auth denied" } });
		const r = await collectFinalizeResult(intent({ gitToken: undefined }), "/ws", {
			fs: fakeFs({}),
			git,
		});
		expect(r.pushed).toBe(false);
		expect(r.stages.find((s) => s.stage === "branch_push")?.status).toBe("failed");
		expect(r.events.some((e) => e.kind === "reap_failed")).toBe(true);
	});

	test("an empty push probes dirtiness (dropped-commit signal)", async () => {
		const { git } = fakeGit({
			"rev-list": { stdout: "0" },
			status: { stdout: " M src/x.ts" },
		});
		const r = await collectFinalizeResult(intent({ gitToken: undefined }), "/ws", {
			fs: fakeFs({}),
			git,
		});
		expect(r.commitsAhead).toBe(0);
		expect(r.emptyPush).toBe(true);
		expect(r.dirty).toBe(true);
	});

	test("the collected result round-trips through the wire validator unchanged (shape parity)", async () => {
		const fs = fakeFs(
			{ "/ws/.seeds/issues.jsonl": '{"id":"warren-1"}\n' },
			{ "/ws/.mulch/expertise": ["build.jsonl"] },
		);
		fs.readFile = (
			(orig) => (path: string) =>
				path === "/ws/.mulch/expertise/build.jsonl" ? Promise.resolve('{"id":"a"}\n') : orig(path)
		)(fs.readFile);
		const { git } = fakeGit({ "rev-list": { stdout: "2" } });
		const r = await collectFinalizeResult(intent(), "/ws", { fs, git });
		// Wire round-trip: JSON encode → validate → must equal the source shape.
		const roundTripped = validateFinalizeResult(JSON.parse(JSON.stringify(r)));
		expect(roundTripped).toEqual(r);
	});
});

describe("extractIntent", () => {
	test("returns null for {intent:null} and the intent object otherwise", () => {
		expect(extractIntent({ intent: null })).toBeNull();
		expect(extractIntent({})).toBeNull();
		expect(extractIntent({ intent: intent() })?.attemptId).toBe("fin_abcdefghjkmn");
	});
});

describe("pollForIntent + runFinalizeEntrypoint", () => {
	const env = {
		WARREN_RUN_ID: "run_x",
		WARREN_API_URL: "http://warren:8080",
		WARREN_API_TOKEN: "tok",
		WARREN_WORKSPACE_PATH: "/ws",
	};

	test("polls until an intent appears, then collects and POSTs the result", async () => {
		let getCalls = 0;
		const posted: { url: string; body: unknown }[] = [];
		const http: FinalizeHttp = {
			get: async () => {
				getCalls++;
				// First poll: not ready; second: the intent.
				return getCalls < 2
					? { status: 200, body: { intent: null } }
					: { status: 200, body: { intent: intent() } };
			},
			post: async (url, _t, body) => {
				posted.push({ url, body });
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "1" } });
		const did = await runFinalizeEntrypoint(env, {
			http,
			git,
			fs: fakeFs({}),
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		});
		expect(did).toBe(true);
		expect(getCalls).toBe(2);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.url).toBe("http://warren:8080/runs/run_x/finalize-result");
		const env0 = posted[0]?.body as { attemptId: string; version: number };
		expect(env0.attemptId).toBe("fin_abcdefghjkmn");
		expect(env0.version).toBe(IN_POD_FINALIZE_WIRE_VERSION);
	});

	test("a thrown intent GET is a transient poll miss — keeps polling, then completes (warren-4e36)", async () => {
		// Live GKE failure: the FIRST poll after the agent's long run landed on a
		// stale kept-alive socket and fetch threw "Unable to connect" — the whole
		// finalize died on poll #1 and reap failed every step. A thrown GET must
		// retry exactly like a not-ready 200.
		let getCalls = 0;
		const posted: unknown[] = [];
		const http: FinalizeHttp = {
			get: async () => {
				getCalls++;
				if (getCalls === 1)
					throw new Error("Unable to connect. Is the computer able to access the url?");
				return { status: 200, body: { intent: intent() } };
			},
			post: async (_u, _t, body) => {
				posted.push(body);
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "1" } });
		const logs: string[] = [];
		const did = await runFinalizeEntrypoint(env, {
			http,
			git,
			fs: fakeFs({}),
			sleep: async () => {},
			now: () => 0,
			log: (m) => {
				logs.push(m);
			},
		});
		expect(did).toBe(true);
		expect(getCalls).toBe(2);
		expect(posted).toHaveLength(1);
		expect(logs.some((m) => m.includes("intent poll failed"))).toBe(true);
	});

	test("retries the result POST on a transient connect error, then succeeds", async () => {
		let getCalls = 0;
		let postCalls = 0;
		const sleeps: number[] = [];
		const http: FinalizeHttp = {
			get: async () => {
				getCalls++;
				return { status: 200, body: { intent: intent() } };
			},
			post: async () => {
				postCalls++;
				// First two attempts fail with a connect error (fetch throws), third 200s.
				if (postCalls < 3)
					throw new Error("Unable to connect. Is the computer able to access the url?");
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "1" } });
		const did = await runFinalizeEntrypoint(
			{ ...env, WARREN_FINALIZE_POST_RETRY_BASE_MS: "5" },
			{
				http,
				git,
				fs: fakeFs({}),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				now: () => 0,
				log: () => {},
			},
		);
		expect(did).toBe(true);
		expect(postCalls).toBe(3);
		// Exponential backoff between the three attempts: 5ms then 10ms.
		expect(sleeps).toEqual([5, 10]);
		expect(getCalls).toBeGreaterThanOrEqual(1);
	});

	test("postResultWithRetry gives up after max attempts and returns false", async () => {
		let postCalls = 0;
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async () => {
				postCalls++;
				return { status: 503 }; // non-2xx every time
			},
		};
		const parsed = parseFinalizeEntrypointEnv({
			...env,
			WARREN_FINALIZE_POST_MAX_ATTEMPTS: "3",
			WARREN_FINALIZE_POST_RETRY_BASE_MS: "1",
		});
		const delivered = await postResultWithRetry(
			parsed,
			http,
			async () => {},
			() => {},
			"http://warren:8080/runs/run_x/finalize-result",
			{ version: IN_POD_FINALIZE_WIRE_VERSION, attemptId: "fin_x", result: {} as never },
		);
		expect(delivered).toBe(false);
		expect(postCalls).toBe(3); // exactly max attempts, no more
	});

	test("warren-9d24 defaults: maxWait gives up below the 45-min heartbeat watchdog; early salvage at 5 min", () => {
		const parsed = parseFinalizeEntrypointEnv(env);
		expect(parsed.maxWaitMs).toBe(DEFAULT_FINALIZE_MAX_WAIT_MS);
		expect(parsed.maxWaitMs).toBe(2_400_000);
		// Cross-budget guard: a pod polling for an intent is silent, so the
		// finalize wait must end before the heartbeat watchdog terminalizes the
		// run — otherwise the terminal no_intent salvage POST lands after the
		// run-scope gate starts 401ing (warren-9d24).
		expect(DEFAULT_FINALIZE_MAX_WAIT_MS).toBeLessThan(DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS);
		expect(parsed.earlySalvageMs).toBe(300_000);
		// `0` disables the early capture.
		expect(
			parseFinalizeEntrypointEnv({ ...env, WARREN_FINALIZE_EARLY_SALVAGE_MS: "0" }).earlySalvageMs,
		).toBe(0);
	});

	test("an intent landing AFTER the early-salvage mark still finalizes — salvage posted once, first", async () => {
		let clock = 0;
		const posted: string[] = [];
		const http: FinalizeHttp = {
			get: async () =>
				clock < 20
					? { status: 200, body: { intent: null } }
					: { status: 200, body: { intent: intent() } },
			post: async (url) => {
				// The window-3 credential re-mint is plumbing, not a capture (warren-c9ac).
				if (url.endsWith("/git-credential")) return { status: 503 };
				posted.push(url);
				return { status: 200 };
			},
		};
		const { git } = fakeGit({ "rev-list": { stdout: "1" } });
		const did = await runFinalizeEntrypoint(
			{
				...env,
				WARREN_BASE_BRANCH: "main",
				WARREN_FINALIZE_EARLY_SALVAGE_MS: "10",
				WARREN_FINALIZE_MAX_WAIT_MS: "100000",
			},
			{
				http,
				git,
				fs: fakeFs({}),
				sleep: async () => {
					clock += 5;
				},
				now: () => clock,
				log: () => {},
				readFileBytes: async () => new TextEncoder().encode("bundle-bytes"),
				rm: async () => {},
			},
		);
		expect(did).toBe(true);
		const salvagePosts = posted.filter((u) => u.endsWith("/salvage"));
		expect(salvagePosts).toHaveLength(1); // exactly one early capture
		// The early salvage rode BEFORE the result POST that full finalize ends in.
		expect(posted[0]).toBe("http://warren:8080/runs/run_x/salvage");
		expect(posted[posted.length - 1]).toBe("http://warren:8080/runs/run_x/finalize-result");
	});

	test("gives up (no POST) when the intent never arrives before maxWait", async () => {
		let nowVal = 0;
		const http: FinalizeHttp = {
			get: async () => ({ status: 200, body: { intent: null } }),
			post: async () => {
				throw new Error("must not POST without an intent");
			},
		};
		const parsed = parseFinalizeEntrypointEnv({ ...env, WARREN_FINALIZE_MAX_WAIT_MS: "10" });
		const intentResult = await pollForIntent(
			parsed,
			http,
			async () => {
				nowVal += 100; // each sleep advances past the 10ms deadline
			},
			() => nowVal,
			() => {},
		);
		expect(intentResult).toBeNull();
	});
});
