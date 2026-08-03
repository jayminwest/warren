import { describe, expect, test } from "bun:test";
import { gatherPrContext } from "./pr-open.ts";
import type { ReapExec } from "./types.ts";

/**
 * warren-50c8: PR seed attribution reads the run row's authoritative `seedId`.
 * The prompt regex scan survives only as a fallback for legacy/manual runs
 * dispatched without one, and it now refuses ambiguous prompts.
 */

interface Recorder {
	readonly exec: ReapExec;
	readonly shown: string[];
}

function recordingExec(titles: Record<string, string> = {}): Recorder {
	const shown: string[] = [];
	const exec: ReapExec = {
		run: async (cmd, args) => {
			if (cmd !== "sd") throw new Error(`unexpected command: ${cmd}`);
			const id = args[1];
			if (id === undefined) throw new Error("missing seed id");
			shown.push(id);
			const title = titles[id];
			if (title === undefined) throw new Error(`Issue not found: ${id}`);
			return { stdout: JSON.stringify({ issue: { id, title } }), stderr: "" };
		},
	};
	return { exec, shown };
}

const BASE = {
	// No host workspace and no cloneFetch: commit/diff-stat sections degrade to
	// empty, so `sd show` is the only command these tests exercise.
	workspacePath: null,
	projectPath: "/tmp/project",
	baseBranch: "main",
} as const;

describe("gatherPrContext seed attribution", () => {
	test("prefers run.seedId over other seed ids mentioned in the prompt", async () => {
		const rec = recordingExec({ "warren-50c8": "the real issue" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Work seeds issue warren-8cbf, but see warren-e14e for context.",
			seedId: "warren-50c8",
			exec: rec.exec,
		});
		expect(ctx.seed).toEqual({ id: "warren-50c8", title: "the real issue" });
		expect(rec.shown).toEqual(["warren-50c8"]);
	});

	test("falls back to the prompt scan when the run carries no seedId", async () => {
		const rec = recordingExec({ "warren-8cbf": "legacy issue" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Work seeds issue warren-8cbf from the queue.",
			seedId: null,
			exec: rec.exec,
		});
		expect(ctx.seed).toEqual({ id: "warren-8cbf", title: "legacy issue" });
		expect(rec.shown).toEqual(["warren-8cbf"]);
	});

	test("declines an ambiguous prompt naming several distinct seed ids", async () => {
		const rec = recordingExec({ "warren-8cbf": "first", "warren-e14e": "second" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Fix warren-8cbf, which duplicates warren-e14e.",
			exec: rec.exec,
		});
		expect(ctx.seed).toBeNull();
		expect(rec.shown).toEqual([]);
	});

	test("accepts a repeated single seed id in the prompt", async () => {
		const rec = recordingExec({ "warren-8cbf": "repeated" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "warren-8cbf: do the thing. Close warren-8cbf when done.",
			exec: rec.exec,
		});
		expect(ctx.seed).toEqual({ id: "warren-8cbf", title: "repeated" });
		expect(rec.shown).toEqual(["warren-8cbf"]);
	});

	test("returns null when the seedId lookup fails", async () => {
		const rec = recordingExec();
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "no seed here",
			seedId: "warren-dead",
			exec: rec.exec,
		});
		expect(ctx.seed).toBeNull();
		expect(rec.shown).toEqual(["warren-dead"]);
	});
});
