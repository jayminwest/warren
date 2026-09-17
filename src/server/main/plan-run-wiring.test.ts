/**
 * Reopen-seam coverage for the auto-merge arm (warren-14d6 / pl-92a3
 * step 6): a child PR the coordinator's `reopenPr` seam opens must arm
 * through the SAME `runAutoMergeArm` the reap PR-open sub-step uses, with
 * the events stamped on the child run's stream — and a project that never
 * opted in must arm nothing, emit nothing, and still get its PR URL back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../../projects/clone.ts";
import { type Ctx, fakeForge, setup, TEST_REPO_REF } from "../../runs/reap/test-helpers.ts";
import type { LoadedWarrenConfig } from "../../warren-config/index.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import type { Logger } from "../types.ts";
import { createReopenPr } from "./plan-run-wiring.ts";

const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

/** Base-ref `.warren/config.yaml` content carrying the auto-merge opt-in. */
const BASE_CONFIG_YAML = "pr:\n  autoMerge:\n    method: squash\n";

function makeLogger(): { logger: Logger; warns: Array<{ obj: object; msg?: string }> } {
	const warns: Array<{ obj: object; msg?: string }> = [];
	const logger = {
		info: () => {},
		warn: (obj: object, msg?: string) => warns.push({ obj, msg }),
		error: () => {},
		debug: () => {},
	} as unknown as Logger;
	return { logger, warns };
}

/** A `SpawnFn` answering the arm step's git reads (`show`, diff, fetch). */
function gitSpawn(opts: { showStdout?: string; nameOnlyDiff?: string } = {}): {
	spawn: SpawnFn;
	calls: { cmd: readonly string[] }[];
} {
	const calls: { cmd: readonly string[] }[] = [];
	const spawn: SpawnFn = async (cmd): Promise<SpawnResult> => {
		calls.push({ cmd });
		if (cmd[0] === "git" && cmd[1] === "show") {
			return { stdout: opts.showStdout ?? "", stderr: "", exitCode: 0 };
		}
		if (cmd.includes("--name-only")) {
			return { stdout: opts.nameOnlyDiff ?? "", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

/** A warren-config cache whose loaded project config carries `pr.autoMerge`. */
function configCache(prAutoMerge: boolean) {
	return createWarrenConfigCache({
		load: async (): Promise<LoadedWarrenConfig> => ({
			triggers: null,
			defaults: prAutoMerge ? { pr: { autoMerge: { method: "squash", protectedPaths: [] } } } : {},
			prTemplate: null,
			sourceFile: ".warren/config.yaml",
			errors: [],
			warnings: [],
		}),
	});
}

describe("createReopenPr auto-merge arm (warren-14d6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("arms the reopened PR through runAutoMergeArm and stamps the event on the run stream", async () => {
		const { logger } = makeLogger();
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const git = gitSpawn({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const reopenPr = createReopenPr({
			repos: ctx.repos,
			warrenConfigs: configCache(true),
			autoOpenPr: AUTO_OPEN,
			forge,
			projectSpawn: git.spawn,
			logger,
		});
		expect(reopenPr).toBeDefined();
		const url = await reopenPr?.(ctx.runId);
		expect(url).toBe("fake://x/y/pulls/1");
		// The PR reap-equivalent arming targets is #1 in the fake store, and it
		// is armed — the same live fake-forge path the reap tests exercise.
		expect(forge.store.getPr(TEST_REPO_REF.key, 1)?.autoMerge).toBe("armed");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const armed = events.find((ev) => ev.kind === "reap.auto_merge_armed");
		expect(armed?.payloadJson).toMatchObject({
			prUrl: "fake://x/y/pulls/1",
			prNumber: 1,
			method: "squash",
			outcome: "armed",
		});
		expect(events.filter((ev) => ev.kind.startsWith("reap.auto_merge_"))).toHaveLength(1);
	});

	test("arms nothing and emits nothing when the project has no pr.autoMerge block", async () => {
		const { logger } = makeLogger();
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const git = gitSpawn({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const reopenPr = createReopenPr({
			repos: ctx.repos,
			warrenConfigs: configCache(false),
			autoOpenPr: AUTO_OPEN,
			forge,
			projectSpawn: git.spawn,
			logger,
		});
		const url = await reopenPr?.(ctx.runId);
		expect(url).toBe("fake://x/y/pulls/1");
		expect(forge.store.getPr(TEST_REPO_REF.key, 1)?.autoMerge).toBe("unarmed");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.filter((ev) => ev.kind.startsWith("reap.auto_merge_"))).toHaveLength(0);
	});

	test("still returns the PR URL when the arm step explodes (best-effort)", async () => {
		const { logger, warns } = makeLogger();
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		forge.armAutoMerge = (() => {
			throw new Error("transport exploded");
		}) as typeof forge.armAutoMerge;
		const git = gitSpawn({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const reopenPr = createReopenPr({
			repos: ctx.repos,
			warrenConfigs: configCache(true),
			autoOpenPr: AUTO_OPEN,
			forge,
			projectSpawn: git.spawn,
			logger,
		});
		const url = await reopenPr?.(ctx.runId);
		// The reopen's own outcome is never held hostage by arming.
		expect(url).toBe("fake://x/y/pulls/1");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const notArmed = events.find((ev) => ev.kind === "reap.auto_merge_not_armed");
		expect(notArmed?.payloadJson).toMatchObject({ reason: "unknown" });
		expect(warns).toHaveLength(0);
	});
});
