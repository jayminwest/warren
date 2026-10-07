import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { spawnRun } from "./index.ts";
import { makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-c2c8: a failure after `provider.create()` succeeded (here: the
 * correlation write) must tear down the live workload, not leave it running
 * untracked behind a `failed`/`never_started` row.
 */

const CANCEL = (id: string) => `POST /runs/${id}/cancel`;
const DESTROY = (id: string) => `DELETE /sandboxes/${id}`;

function callKeys(provider: FakeProvider): string[] {
	return provider.calls.map((c) => `${c.method} ${c.path}`);
}

describe("spawnRun: post-create compensation (warren-c2c8)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	function failCorrelationWrite(): void {
		repos.runs.attachBurrow = () => Promise.reject(new Error("db write boom"));
	}

	async function onlyRun() {
		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		return rows[0] as NonNullable<(typeof rows)[0]>;
	}

	test("cancels and terminates the created workload when the correlation write fails", async () => {
		const provider = new FakeProvider();
		failCorrelationWrite();

		await expect(
			spawnRun({
				repos,
				runtimeProvider: provider,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toThrow("db write boom");

		const keys = callKeys(provider);
		const sandboxId = "bur_aaaaaaaaaaaa";
		expect(keys).toContain(CANCEL("run_zzzzzzzzzzzz"));
		expect(keys.filter((k) => k === DESTROY(sandboxId))).toHaveLength(1);

		const run = await onlyRun();
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("never_started");
		const events = await repos.events.listByRun(run.id);
		const failed = events.find((e) => e.kind === "spawn_failed");
		expect((failed?.payloadJson as { sandboxId?: string }).sandboxId).toBe(sandboxId);
	});

	test("still terminates and surfaces the original error when cancel throws", async () => {
		const provider = new FakeProvider({ cancelError: new Error("cancel boom") });
		failCorrelationWrite();

		await expect(
			spawnRun({
				repos,
				runtimeProvider: provider,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toThrow("db write boom");

		expect(callKeys(provider)).toContain(DESTROY("bur_aaaaaaaaaaaa"));
		expect((await onlyRun()).state).toBe("failed");
	});

	test("does not compensate again when create itself fails", async () => {
		const { client } = makeSandboxClient({ runsCreateStatus: 500 });

		await expect(
			spawnRun({
				repos,
				runtimeProvider: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toThrow();

		const keys = callKeys(client);
		// Exactly the provider's own partial-failure destroy, no domain cancel.
		expect(keys.filter((k) => k.startsWith("DELETE /sandboxes/"))).toHaveLength(1);
		expect(keys.some((k) => k.endsWith("/cancel"))).toBe(false);
	});
});
