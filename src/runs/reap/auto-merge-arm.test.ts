import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
	ArmAutoMergeOptions,
	AutoMergeRefusalReason,
	PullRequestRef,
	RepoRef,
} from "../../forge/contract.ts";
import type { AutoMergeConfig } from "../../warren-config/pr-config.ts";
import { type RunAutoMergeArmInput, runAutoMergeArm } from "./auto-merge-arm.ts";
import {
	FAKE_REV_PARSE_SHA,
	fakeExec,
	fakeForge,
	stubForge,
	TEST_REPO_REF,
} from "./test-helpers.ts";

/** The opt-in project block; tests override method/protectedPaths per case. */
const OPT_IN: AutoMergeConfig = { method: "squash", protectedPaths: [] };

/** Base-ref `.warren/config.yaml` content carrying the same opt-in. */
const BASE_CONFIG_YAML = "pr:\n  autoMerge:\n    method: squash\n";

/** Base-ref config WITH a protected path — the policy resolves from the base ref. */
const PROTECTED_BASE_CONFIG_YAML =
	"pr:\n  autoMerge:\n    method: squash\n    protectedPaths:\n      - docs/\n";

/** A recording emit — captures (kind, payload) pairs, never throws. */
function recordingEmit(): {
	emit: RunAutoMergeArmInput["emit"];
	events: { kind: string; payload: unknown }[];
} {
	const events: { kind: string; payload: unknown }[] = [];
	return {
		events,
		emit: async (kind, payload) => {
			events.push({ kind, payload });
			return null;
		},
	};
}

function baseInput(overrides: Partial<RunAutoMergeArmInput> = {}): RunAutoMergeArmInput {
	return {
		projectAutoMerge: OPT_IN,
		run: { id: "run_1", trigger: "manual" },
		project: { gitUrl: "https://github.com/x/y.git", localPath: `${tmpdir()}/unused-host` },
		prUrl: "fake://x/y/pulls/1",
		prNumber: 1,
		repoRef: TEST_REPO_REF,
		prRef: fakePrRef(1),
		branch: "agent/refactor-bot/run-1",
		baseBranch: "main",
		workspacePath: "/data/sandbox/ws",
		forge: fakeForge(),
		exec: fakeExec().exec,
		emit: recordingEmit().emit,
		...overrides,
	};
}

function fakePrRef(number: number): PullRequestRef {
	return {
		forge: TEST_REPO_REF.forge,
		key: `${TEST_REPO_REF.key}#${number}`,
		number,
		webUrl: `fake://${TEST_REPO_REF.key}/pulls/${number}`,
	};
}

/** Read the single event the step must have emitted, asserting exactly-once. */
function onlyEvent(events: { kind: string; payload: unknown }[]): {
	kind: string;
	payload: Record<string, unknown>;
} {
	expect(events).toHaveLength(1);
	const first = events[0];
	if (first === undefined) throw new Error("no event emitted");
	expect(typeof first.payload).toBe("object");
	return { kind: first.kind, payload: first.payload as Record<string, unknown> };
}

/**
 * An armed-capable forge whose armAutoMerge calls are recorded, with PR #1
 * already open in its store so the fake's LIVE arm path (not the script
 * queue) is the code under test.
 */
function armedForge(): {
	forge: ReturnType<typeof fakeForge>;
	armCalls: { ref: RepoRef; number: number; options: ArmAutoMergeOptions }[];
} {
	const forge = fakeForge();
	forge.setAutoMergeArmCapability(true);
	void forge.openPullRequest(TEST_REPO_REF, {
		headBranch: "agent/refactor-bot/run-1",
		baseBranch: "main",
		title: "t",
		body: "b",
	});
	const armCalls: { ref: RepoRef; number: number; options: ArmAutoMergeOptions }[] = [];
	const inner = forge.armAutoMerge.bind(forge);
	forge.armAutoMerge = (ref, pr, options) => {
		armCalls.push({ ref, number: pr.number, options });
		return inner(ref, pr, options);
	};
	return { forge, armCalls };
}

describe("runAutoMergeArm", () => {
	test("emits nothing and makes no git or forge call when the project never opted in", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(
			baseInput({ projectAutoMerge: undefined, forge, exec: e.exec, emit: rec.emit }),
		);
		expect(armCalls).toHaveLength(0);
		expect(e.calls).toHaveLength(0);
		expect(rec.events).toHaveLength(0);
	});

	test("arms through the forge and emits the full armed payload", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(1);
		expect(armCalls[0]?.options).toEqual({ method: "squash" });
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_armed");
		expect(ev.payload).toEqual({
			prUrl: "fake://x/y/pulls/1",
			prNumber: 1,
			method: "squash",
			outcome: "armed",
		});
		expect(forge.store.getPr(TEST_REPO_REF.key, 1)?.autoMerge).toBe("armed");
	});

	test("reports already_armed as success (idempotent re-reap)", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		forge.scriptAutoMergeArm({ outcome: "already_armed" });
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_armed");
		expect(ev.payload).toMatchObject({ outcome: "already_armed" });
	});

	test("skips ci_fixer_run without ever calling the forge", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const forge = stubForge({
			armAutoMerge: () => {
				throw new Error("armAutoMerge must not be called for a CI-fixer run");
			},
		});
		const rec = recordingEmit();
		await runAutoMergeArm(
			baseInput({ run: { id: "run_1", trigger: "ci-fixer" }, forge, exec: e.exec, emit: rec.emit }),
		);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "ci_fixer_run" });
	});

	test("skips off when the base ref carries no pr.autoMerge block", async () => {
		const e = fakeExec({ showStdout: "", nameOnlyDiff: "src/a.ts\0" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(0);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "off" });
	});

	test("skips unsupported_forge when the forge reports the capability false", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const forge = stubForge({
			armAutoMerge: () => {
				throw new Error("armAutoMerge must not be called past a false capability");
			},
		});
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "unsupported_forge" });
	});

	test("skips protected_path naming the matching changed files", async () => {
		const e = fakeExec({
			showStdout: PROTECTED_BASE_CONFIG_YAML,
			nameOnlyDiff: "docs/a.md\0src/b.ts\0",
		});
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(0);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "protected_path", paths: ["docs/a.md"] });
	});

	test("skips config_changed when the diff touches .warren/config.yaml", async () => {
		const e = fakeExec({
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/b.ts\0.warren/config.yaml\0",
		});
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(0);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "config_changed", paths: [".warren/config.yaml"] });
	});

	test("skips empty_diff (fail closed, never arm blind)", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(0);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "empty_diff" });
	});

	test("skips diff_unreadable when the changed-path read fails", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, failNameOnlyDiff: "bad ref" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		expect(armCalls).toHaveLength(0);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_skipped");
		expect(ev.payload).toEqual({ reason: "diff_unreadable" });
	});

	test("reports each forge refusal as not_armed carrying the reason and message", async () => {
		const refusals: AutoMergeRefusalReason[] = [
			"repo_auto_merge_disabled",
			"clean_status",
			"insufficient_permission",
			"mergeability_unsettled",
			"not_open",
			"unknown",
		];
		for (const reason of refusals) {
			const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
			const forge = fakeForge();
			forge.setAutoMergeArmCapability(true);
			forge.scriptAutoMergeArm({ refusal: reason, message: `scripted: ${reason}` });
			const rec = recordingEmit();
			await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
			const ev = onlyEvent(rec.events);
			expect(ev.kind).toBe("reap.auto_merge_not_armed");
			expect(ev.payload).toEqual({ reason, message: `scripted: ${reason}` });
		}
	});

	test("collapses a thrown armAutoMerge into not_armed with reason unknown", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const { forge } = armedForge();
		forge.armAutoMerge = (() => {
			// The class contract says armAutoMerge never throws, but the step
			// must survive a provider that breaks it (warren-14d6 hard invariant).
			return Promise.reject(new Error("transport exploded"));
		}) as typeof forge.armAutoMerge;
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: rec.emit }));
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_not_armed");
		expect(ev.payload).toMatchObject({ reason: "unknown" });
		expect(String(ev.payload.message)).toContain("transport exploded");
	});

	test("never throws, even when the emit itself fails", async () => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const { forge } = armedForge();
		const failingEmit: RunAutoMergeArmInput["emit"] = async () => {
			throw new Error("event append failed");
		};
		await runAutoMergeArm(baseInput({ forge, exec: e.exec, emit: failingEmit }));
	});

	test.each([
		null,
		"/data/sandbox/ws",
	])("fetches remote snapshots with workspace %s", async (workspacePath) => {
		const e = fakeExec({ showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "src/a.ts\0" });
		const { forge, armCalls } = armedForge();
		const rec = recordingEmit();
		await runAutoMergeArm(baseInput({ workspacePath, forge, exec: e.exec, emit: rec.emit }));
		const fetch = e.calls.filter((c) => c.args[0] === "fetch")[1];
		expect(fetch?.args.join(" ")).toContain(
			"refs/heads/agent/refactor-bot/run-1:refs/warren/auto-merge/head",
		);
		const diff = e.calls.find((c) => c.args[0] === "diff" && c.args.includes("--name-only"));
		expect(diff?.args.join(" ")).toContain(`${FAKE_REV_PARSE_SHA}...${FAKE_REV_PARSE_SHA}`);
		expect(fetch?.cwd).not.toBe("/data/projects/x/y");
		expect(existsSync(fetch?.cwd ?? "")).toBe(false);
		expect(armCalls).toHaveLength(1);
		const ev = onlyEvent(rec.events);
		expect(ev.kind).toBe("reap.auto_merge_armed");
	});
});
