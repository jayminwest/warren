/**
 * Both finalize paths surface mulch usage attribution: a workspace
 * `.mulch/state/usage.jsonl` becomes one `mulch.usage` event in
 * `FinalizeResult.events` (re-emitted onto the run by reap), and its absence
 * adds nothing (fail-open).
 */

import { describe, expect, test } from "bun:test";
import { fakeExec, fakeFs } from "../runs/reap/test-helpers.ts";
import type { FinalizeIntent } from "./contract.ts";
import { collectFinalizeResult, type FinalizeGitRunner } from "./k8s/finalize-collect.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./k8s/finalize-wire.ts";
import { finalizeLocalWorkspace } from "./local/finalize.ts";
import { MULCH_USAGE_EVENT } from "./mulch-usage.ts";

const WS = "/data/sandbox/ws";
const USAGE =
	'{"ts":"2026-09-01T00:00:00.000Z","session":"s1","tool":"Read","files":["a.ts"],"ids":["mx-a","mx-b"]}\n' +
	'{"ts":"2026-09-01T00:00:05.000Z","session":"s1","tool":"Edit","files":["a.ts"],"ids":["mx-a"]}\n';

const LOCAL_INTENT: FinalizeIntent = {
	branch: "warren/run-1",
	push: false,
	artifacts: [],
};

function usageEvents(events: ReadonlyArray<{ kind: string; payload: unknown }>) {
	return events.filter((e) => e.kind === MULCH_USAGE_EVENT);
}

describe("LocalProvider finalize — mulch usage", () => {
	test("emits one mulch.usage event summarizing the workspace log", async () => {
		const fs = fakeFs({ [`${WS}/.mulch/state/usage.jsonl`]: USAGE });
		const r = await finalizeLocalWorkspace(
			{ workspacePath: WS, readTracker: async () => null },
			LOCAL_INTENT,
			{ fs: fs.fs, exec: fakeExec().exec },
		);
		const [ev] = usageEvents(r.events);
		expect(ev?.payload).toMatchObject({
			injections: 2,
			uniqueRecords: 2,
			records: [
				{ id: "mx-a", count: 2 },
				{ id: "mx-b", count: 1 },
			],
		});
	});

	test("an absent log adds no event", async () => {
		const r = await finalizeLocalWorkspace(
			{ workspacePath: WS, readTracker: async () => null },
			LOCAL_INTENT,
			{ fs: fakeFs({}).fs, exec: fakeExec().exec },
		);
		expect(usageEvents(r.events)).toEqual([]);
	});
});

describe("K8s in-pod finalize — mulch usage", () => {
	const git: FinalizeGitRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
	const intent = {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: "fin_abcdefghjkmn",
		branch: "warren/run_x",
		push: false,
		artifacts: [],
		commit: [],
	};

	test("emits the mulch.usage event from the pod workspace", async () => {
		const fs = {
			readFile: async (p: string) => {
				if (p === "/ws/.mulch/state/usage.jsonl") return USAGE;
				throw new Error(`ENOENT ${p}`);
			},
			readdir: async () => [],
		};
		const r = await collectFinalizeResult(intent, "/ws", { fs, git });
		expect(usageEvents(r.events)).toHaveLength(1);
		expect(
			(usageEvents(r.events)[0]?.payload as { injections: number } | undefined)?.injections,
		).toBe(2);
	});

	test("a missing log (readFile throws) adds no event", async () => {
		const fs = {
			readFile: async (p: string): Promise<string> => {
				throw new Error(`ENOENT ${p}`);
			},
			readdir: async () => [],
		};
		const r = await collectFinalizeResult(intent, "/ws", { fs, git });
		expect(usageEvents(r.events)).toEqual([]);
	});
});
