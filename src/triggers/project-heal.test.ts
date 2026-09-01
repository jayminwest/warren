import { describe, expect, test } from "bun:test";
import type { ProjectRow } from "../db/schema.ts";
import { AdoForge } from "../forge/ado/provider.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import {
	createProjectCloneHealer,
	NOTICE_INTERVAL_MS,
	ProjectHealTracker,
	RECLONE_BACKOFF_BASE_MS,
	recloneMissingProject,
} from "./project-heal.ts";

const CONFIG: ProjectsConfig = { root: "/data/projects", gitBinary: "git" };

function makeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: "proj_1",
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
		addedAt: "2026-07-21T00:00:00.000Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasSeeds: false,
		...overrides,
	};
}

interface CapturedLog {
	level: "info" | "error";
	obj: Record<string, unknown>;
	msg?: string;
}

function makeLogger(): { logs: CapturedLog[] } & {
	info: (obj: Record<string, unknown>, msg?: string) => void;
	error: (obj: Record<string, unknown>, msg?: string) => void;
} {
	const logs: CapturedLog[] = [];
	return {
		logs,
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
}

describe("ProjectHealTracker", () => {
	test("shouldNotify: first hit true, repeat within interval false, after interval true", () => {
		const tracker = new ProjectHealTracker(1000);
		expect(tracker.shouldNotify("k", 0)).toBe(true);
		expect(tracker.shouldNotify("k", 500)).toBe(false);
		expect(tracker.shouldNotify("k", 1000)).toBe(true);
	});

	test("clearNotice resets the gate so the next hit logs immediately", () => {
		const tracker = new ProjectHealTracker(1000);
		expect(tracker.shouldNotify("k", 0)).toBe(true);
		expect(tracker.shouldNotify("k", 100)).toBe(false);
		tracker.clearNotice("k");
		expect(tracker.shouldNotify("k", 200)).toBe(true);
	});

	test("reclone backoff is exponential and canAttemptReclone honors the window", () => {
		const tracker = new ProjectHealTracker();
		expect(tracker.canAttemptReclone("p", 0)).toBe(true);

		expect(tracker.recordRecloneFailure("p", 0)).toBe(1);
		// First failure arms base delay.
		expect(tracker.canAttemptReclone("p", RECLONE_BACKOFF_BASE_MS - 1)).toBe(false);
		expect(tracker.canAttemptReclone("p", RECLONE_BACKOFF_BASE_MS)).toBe(true);

		expect(tracker.recordRecloneFailure("p", RECLONE_BACKOFF_BASE_MS)).toBe(2);
		// Second failure doubles the delay.
		const secondUntil = RECLONE_BACKOFF_BASE_MS + RECLONE_BACKOFF_BASE_MS * 2;
		expect(tracker.canAttemptReclone("p", secondUntil - 1)).toBe(false);
		expect(tracker.canAttemptReclone("p", secondUntil)).toBe(true);

		tracker.clearRecloneFailure("p");
		expect(tracker.canAttemptReclone("p", 0)).toBe(true);
	});
});

describe("recloneMissingProject", () => {
	test("derives owner/name from gitUrl and pins the stored defaultBranch + token", async () => {
		const calls: Record<string, unknown>[] = [];
		await recloneMissingProject({
			project: makeProject({
				gitUrl: "https://github.com/acme/widget.git",
				defaultBranch: "trunk",
			}),
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			gitCredential: { username: "x-access-token", secret: "ghs_secret", host: "github.com" },
			clone: async (input) => {
				calls.push({ ...input, spawn: undefined });
				return { localPath: input.config.root, defaultBranch: input.defaultBranch ?? "" };
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			owner: "acme",
			name: "widget",
			gitUrl: "https://github.com/acme/widget.git",
			defaultBranch: "trunk",
			gitCredential: { username: "x-access-token", secret: "ghs_secret", host: "github.com" },
		});
	});

	test("lays a forge-owned URL out under the owner/name addProject chose", async () => {
		const calls: Record<string, unknown>[] = [];
		await recloneMissingProject({
			project: makeProject({ gitUrl: "https://dev.azure.com/acme/Widgets/_git/widget" }),
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			forge: new AdoForge({ token: "t" }),
			clone: async (input) => {
				calls.push({ ...input, spawn: undefined });
				return { localPath: input.config.root, defaultBranch: input.defaultBranch ?? "" };
			},
		});
		expect(calls[0]).toMatchObject({ owner: "acme-Widgets", name: "widget" });
	});

	test("throws on a forge-owned URL when no forge is in reach", async () => {
		await expect(
			recloneMissingProject({
				project: makeProject({ gitUrl: "https://dev.azure.com/acme/Widgets/_git/widget" }),
				config: CONFIG,
				spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				clone: async (input) => ({ localPath: input.config.root, defaultBranch: "" }),
			}),
		).rejects.toThrow(/unrecognized GitHub URL/);
	});
});

describe("createProjectCloneHealer", () => {
	test("present clone → 'present', no re-clone, clears prior backoff", async () => {
		const tracker = new ProjectHealTracker();
		tracker.recordRecloneFailure("proj_1", 0);
		let recloneCalls = 0;
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => true,
			reclone: async () => {
				recloneCalls += 1;
			},
			now: () => new Date(0),
		});
		expect(await heal(makeProject())).toBe("present");
		expect(recloneCalls).toBe(0);
		expect(tracker.canAttemptReclone("proj_1", 0)).toBe(true);
	});

	test("missing clone → re-clones once and returns 'recloned'", async () => {
		const tracker = new ProjectHealTracker();
		const logger = makeLogger();
		let recloneCalls = 0;
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => false,
			logger,
			reclone: async () => {
				recloneCalls += 1;
			},
			now: () => new Date(0),
		});
		expect(await heal(makeProject())).toBe("recloned");
		expect(recloneCalls).toBe(1);
		expect(logger.logs.some((l) => l.msg === "scheduler.project_recloned")).toBe(true);
	});

	test("forwards the boot-resolved forge to the re-clone, so non-GitHub rows heal", async () => {
		const tracker = new ProjectHealTracker();
		const forge = new AdoForge({ token: "t" });
		let seenForge: unknown = "unset";
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => false,
			forge,
			reclone: async (input) => {
				seenForge = input.forge;
			},
			now: () => new Date(0),
		});
		expect(await heal(makeProject())).toBe("recloned");
		expect(seenForge).toBe(forge);
	});

	test("forwards the minted credential as gitCredential, so private re-clones authenticate", async () => {
		const tracker = new ProjectHealTracker();
		const minted = { username: "x-access-token", secret: "s3cret", host: "dev.azure.com" };
		let seenCredential: unknown = "unset";
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => false,
			mintCredential: async () => minted,
			reclone: async (input) => {
				seenCredential = input.gitCredential;
			},
			now: () => new Date(0),
		});
		expect(await heal(makeProject())).toBe("recloned");
		expect(seenCredential).toBe(minted);
	});

	test("failed re-clone backs off and logs once, not every tick", async () => {
		const tracker = new ProjectHealTracker();
		const logger = makeLogger();
		let recloneCalls = 0;
		let clockMs = 0;
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => false,
			logger,
			reclone: async () => {
				recloneCalls += 1;
				throw new Error("repo deleted upstream");
			},
			now: () => new Date(clockMs),
		});

		const project = makeProject();
		// Tick 1: attempts, fails, logs.
		expect(await heal(project)).toBe("skip");
		// Tick 2 (60s later, still inside backoff): no attempt, no new log.
		clockMs = 60_000;
		expect(await heal(project)).toBe("skip");

		expect(recloneCalls).toBe(1);
		const failLogs = logger.logs.filter((l) => l.msg === "scheduler.project_reclone_failed");
		expect(failLogs).toHaveLength(1);
		expect(failLogs[0]?.level).toBe("error");

		// After the notice interval AND the backoff window: attempts + logs again.
		clockMs = NOTICE_INTERVAL_MS + 1;
		expect(await heal(project)).toBe("skip");
		expect(recloneCalls).toBe(2);
		expect(logger.logs.filter((l) => l.msg === "scheduler.project_reclone_failed")).toHaveLength(2);
	});

	test("re-clone that succeeds after failures clears backoff", async () => {
		const tracker = new ProjectHealTracker();
		let present = false;
		let shouldFail = true;
		const heal = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => present,
			reclone: async () => {
				if (shouldFail) throw new Error("transient");
				present = true;
			},
			now: () => new Date(0),
		});
		const project = makeProject();
		expect(await heal(project)).toBe("skip");
		expect(tracker.canAttemptReclone("proj_1", 0)).toBe(false);

		// Backoff window elapsed, this time the clone succeeds.
		shouldFail = false;
		const healLater = createProjectCloneHealer({
			tracker,
			config: CONFIG,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			exists: () => present,
			reclone: async () => {
				present = true;
			},
			now: () => new Date(RECLONE_BACKOFF_BASE_MS),
		});
		expect(await healLater(project)).toBe("recloned");
		expect(tracker.canAttemptReclone("proj_1", RECLONE_BACKOFF_BASE_MS)).toBe(true);
	});
});
