/**
 * warren-8d95: `LocalProvider.finalize`'s `seed_reset` stage. Drives the real
 * finalize body against faked fs/exec/burrow to verify that warren-seeded
 * pure-context artifacts are reset to base before `branch_push` — but only when
 * the live workspace bytes still equal what warren seeded (an intentional agent
 * edit is preserved) — and that the reset lands as one bookkeeping commit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	openDatabase,
} from "../../runs/reap/test-helpers.ts";
import type { FinalizeIntent, RunHandle } from "../contract.ts";
import { LocalProvider } from "./provider.ts";

const WS = "/data/burrow/ws";
const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};
const AGENT_ENVELOPE = ".warren/agent.json";
const SEED = '{\n  "name": "claude-code"\n}\n';

let openDb: WarrenDb | null = null;
afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function provider(fs: ReturnType<typeof fakeFs>, exec: ReturnType<typeof fakeExec>) {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	const client = fakeBurrowClient(makeBurrow({ workspacePath: WS }));
	const pool = await makePool(client, repos);
	return new LocalProvider({ burrowClient: () => pool, fs: fs.fs, exec: exec.exec });
}

/** Reset-only intent: no mirror/commit stages, just the seed reset + push. */
function intent(overrides: Partial<FinalizeIntent> = {}): FinalizeIntent {
	return {
		branch: "warren/run-1",
		push: true,
		mirror: [],
		baseBranch: "main",
		resetSeededPaths: [{ path: AGENT_ENVELOPE, contents: SEED }],
		...overrides,
	};
}

function gitCall(exec: ReturnType<typeof fakeExec>, ...sub: string[]) {
	return exec.calls.find((c) => c.cmd === "git" && sub.every((s, i) => c.args[i] === s));
}

describe("finalize — seed_reset stage (warren-8d95)", () => {
	test("resets an unedited seeded artifact to base and commits before push", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: SEED });
		const exec = fakeExec({ stagedDelta: true }); // diff --cached --quiet fails ⇒ staged
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent());

		expect(result.stages.find((s) => s.stage === "seed_reset")?.status).toBe("ok");
		expect(gitCall(exec, "checkout", "main", "--", AGENT_ENVELOPE)).toBeDefined();
		const commit = exec.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
		expect(commit?.args).toContain("--no-verify");
		expect(result.events.some((e) => e.kind === "reap.seed_reset")).toBe(true);
	});

	test("seed_reset runs BEFORE branch_push in the stage trail", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: SEED });
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider(fs, exec);
		const stages = (await p.finalize(HANDLE, intent())).stages.map((s) => s.stage);
		expect(stages.indexOf("seed_reset")).toBeLessThan(stages.indexOf("branch_push"));
	});

	test("leaves an agent-edited seeded artifact untouched (no checkout, no commit)", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: '{"name":"edited-by-agent"}\n' });
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent());

		expect(result.stages.find((s) => s.stage === "seed_reset")?.status).toBe("ok");
		expect(gitCall(exec, "checkout", "main", "--", AGENT_ENVELOPE)).toBeUndefined();
		expect(result.events.some((e) => e.kind === "reap.seed_reset")).toBe(false);
	});

	test("no-op when the seeded artifact never materialized in the workspace", async () => {
		const fs = fakeFs({});
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent());
		expect(gitCall(exec, "checkout", "main", "--", AGENT_ENVELOPE)).toBeUndefined();
		expect(result.stages.find((s) => s.stage === "seed_reset")?.status).toBe("ok");
	});

	test("skips seed_reset (no stage failure) when no baseBranch is supplied", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: SEED });
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent({ baseBranch: undefined }));
		expect(result.stages.find((s) => s.stage === "seed_reset")?.status).toBe("skipped");
		expect(gitCall(exec, "checkout")).toBeUndefined();
	});

	test("absent resetSeededPaths leaves seed_reset out of the stage trail entirely", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: SEED });
		const exec = fakeExec();
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent({ resetSeededPaths: undefined }));
		expect(result.stages.some((s) => s.stage === "seed_reset")).toBe(false);
	});

	test("a git failure during reset surfaces as a failed stage, not a throw", async () => {
		const fs = fakeFs({ [`${WS}/${AGENT_ENVELOPE}`]: SEED });
		const exec = fakeExec({ fail: "git checkout blew up" });
		const p = await provider(fs, exec);
		const result = await p.finalize(HANDLE, intent());
		expect(result.stages.find((s) => s.stage === "seed_reset")?.status).toBe("failed");
		expect(result.events.some((e) => e.kind === "reap_failed")).toBe(true);
	});
});
