import { describe, expect, test } from "bun:test";
import { IdempotencyStore, type IdempotentDispatch } from "./idempotency.ts";

function fakeDispatch(runId: string): IdempotentDispatch {
	return {
		run: { id: runId } as IdempotentDispatch["run"],
		sandbox: { id: `bur_${runId}`, workspacePath: "/ws" },
	};
}

describe("IdempotencyStore", () => {
	test("replays the cached result for the same (projectId, key) within the window", async () => {
		const store = new IdempotencyStore();
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			return fakeDispatch("run_1");
		};

		const first = await store.run("proj_a", "key", dispatch);
		const second = await store.run("proj_a", "key", dispatch);

		expect(calls).toBe(1);
		expect(second).toBe(first);
	});

	test("different key re-runs dispatch", async () => {
		const store = new IdempotencyStore();
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			return fakeDispatch(`run_${calls}`);
		};

		await store.run("proj_a", "k1", dispatch);
		await store.run("proj_a", "k2", dispatch);

		expect(calls).toBe(2);
	});

	test("same key under a different project is not deduped", async () => {
		const store = new IdempotencyStore();
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			return fakeDispatch(`run_${calls}`);
		};

		await store.run("proj_a", "shared", dispatch);
		await store.run("proj_b", "shared", dispatch);

		expect(calls).toBe(2);
	});

	test("expired entry re-runs dispatch", async () => {
		let clock = 0;
		const store = new IdempotencyStore({ ttlMs: 100, now: () => clock });
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			return fakeDispatch(`run_${calls}`);
		};

		await store.run("proj_a", "k", dispatch);
		clock += 101;
		await store.run("proj_a", "k", dispatch);

		expect(calls).toBe(2);
	});

	test("concurrent duplicates await the same in-flight dispatch", async () => {
		const store = new IdempotencyStore();
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const dispatch = async () => {
			calls += 1;
			await gate;
			return fakeDispatch("run_only");
		};

		const p1 = store.run("proj_a", "k", dispatch);
		const p2 = store.run("proj_a", "k", dispatch);
		release?.();
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(calls).toBe(1);
		expect(r1).toBe(r2);
	});

	test("a failed dispatch evicts the entry so a retry re-spawns", async () => {
		const store = new IdempotencyStore();
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return fakeDispatch("run_2");
		};

		await expect(store.run("proj_a", "k", dispatch)).rejects.toThrow("boom");
		const ok = await store.run("proj_a", "k", dispatch);

		expect(calls).toBe(2);
		expect(ok.run.id).toBe("run_2");
	});
});
