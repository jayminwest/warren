import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { ForgeCapabilities } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { DEFAULT_RUN_BRANCH_PREFIX } from "../runs/branch.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { runTick } from "./tick.ts";

const NOW = new Date("2026-05-11T00:05:00.000Z");

function ciFixerConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: {
			ciFixer: {
				enabled: true,
				maxRetries: 2,
				cooldownMinutes: 10,
				logTailLines: 200,
				role: "pr-fixer",
			},
		},
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

function emptyConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: null,
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

/** Override a FakeForge capability flag (test seam — the flags are readonly). */
function withCapabilities(forge: FakeForge, over: Partial<ForgeCapabilities>): FakeForge {
	Object.defineProperty(forge, "capabilities", {
		value: { ...forge.capabilities, ...over },
	});
	return forge;
}

describe("runCiFixerPass (via runTick)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function openPr(): Promise<string> {
		const opener = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "open the PR",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(opener.id, NOW);
		await repos.runs.setPrUrl(opener.id, "fake://x/y/pulls/9");
		return opener.id;
	}

	test("dispatches a fixer for a failing PR and stamps a system event", async () => {
		const openerId = await openPr();

		// warren-0b49: the poller consumes the Forge seam — FakeForge owns
		// `fake://` urls and reports the seeded check runs for the head ref
		// (`${DEFAULT_RUN_BRANCH_PREFIX}/${runId}`).
		const forge = new FakeForge();
		const ref = forge.parseRepoRef("fake://x/y/pulls/9");
		if (ref === null) throw new Error("fake forge must own fake:// urls");
		forge.setChecks(ref, `${DEFAULT_RUN_BRANCH_PREFIX}/${openerId}`, [
			{
				name: "test",
				status: "completed",
				conclusion: "failure",
				jobId: "1",
				detailsUrl: null,
			},
		]);
		const spawnCalls: { projectId: string; agentName: string; parentRunId: string }[] = [];

		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ciFixerConfig(),
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				forge,
				spawn: async (i) => {
					spawnCalls.push({
						projectId: i.projectId,
						agentName: i.agentName,
						parentRunId: i.parentRunId,
					});
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawnCalls).toEqual([{ projectId, agentName: "pr-fixer", parentRunId: openerId }]);
		const events = await repos.events.listByRun(openerId);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("ci_fixer.dispatched");
		expect(events[0]?.stream).toBe("system");
		const payload = events[0]?.payloadJson as { prUrl: string; fixerRunId: string };
		expect(payload).toEqual({ prUrl: "fake://x/y/pulls/9", fixerRunId: "run_fixer" });
	});

	test("is a no-op when the project hasn't opted in", async () => {
		const openerId = await openPr();

		let spawned = 0;
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				forge: new FakeForge(),
				spawn: async () => {
					spawned += 1;
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawned).toBe(0);
		expect(await repos.events.listByRun(openerId)).toHaveLength(0);
	});

	// warren-0b49 (forge-contract.md §5): a forge without checkRuns keeps the
	// poller IDLE and emits ONE notice per project — never a per-PR per-tick
	// error stream.
	test("capabilities.checkRuns false keeps the poller idle with one gated notice per project", async () => {
		const openerId = await openPr();
		const forge = withCapabilities(new FakeForge(), { checkRuns: false });
		let listChecksCalls = 0;
		forge.listChecks = (async () => {
			listChecksCalls += 1;
			throw new Error("listChecks must not be called when checkRuns is false");
		}) as FakeForge["listChecks"];

		const notices: string[] = [];
		const seen = new Set<string>();
		let spawned = 0;
		const tick = () =>
			runTick({
				repos,
				now: () => NOW,
				loadWarrenConfig: async () => ciFixerConfig(),
				spawn: async () => ({ runId: "unused" }),
				noticeGate: {
					shouldNotify: (key) => {
						if (seen.has(key)) return false;
						seen.add(key);
						notices.push(key);
						return true;
					},
					clearNotice: () => {},
				},
				ciFixer: {
					forge,
					spawn: async () => {
						spawned += 1;
						return { runId: "run_fixer" };
					},
				},
			});

		await tick();
		await tick();

		expect(listChecksCalls).toBe(0);
		expect(spawned).toBe(0);
		expect(await repos.events.listByRun(openerId)).toHaveLength(0);
		expect(notices).toEqual([`ci_fixer_unsupported:${projectId}`]);
	});
});
