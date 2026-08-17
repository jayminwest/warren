import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * Durable spawn-failure trail (warren-fc6e / pl-f700 step 2): a spawn that
 * fails past the warren-row point lands a `failed` row carrying
 * `failure_reason = never_started` plus a `spawn_failed` system event that
 * records the cause, mirroring the `reap_failed` pattern so RunDetail shows
 * it for free.
 */
describe("spawnRun: durable spawn failure", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	const spawnFailedEvent = async (runId: string) =>
		(await repos.events.listByRun(runId)).find((e) => e.kind === "spawn_failed");

	test("records failure_reason + spawn_failed event when burrow rejects the seed payload", async () => {
		const { client } = makeSandboxClient({
			sandboxUpStatus: 422,
			sandboxUpBody: {
				error: { code: "validation_error", message: "seed file rejected: path escapes root" },
			},
		});
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const row = (await repos.runs.listAll())[0];
		expect(row?.state).toBe("failed");
		expect(row?.failureReason).toBe("never_started");

		const ev = await spawnFailedEvent(row?.id ?? "");
		expect(ev?.stream).toBe("system");
		const payload = ev?.payloadJson as { step?: string; message?: string; sandboxId?: string };
		expect(payload.step).toBe("spawn");
		expect(payload.message).toContain("seed file rejected");
		// No burrow id was ever observed (rollback before attach), so it's elided.
		expect(payload.sandboxId).toBeUndefined();
	});

	test("records a spawn_failed event when dispatch fails (burrow id owned by the provider)", async () => {
		const { client } = makeSandboxClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const row = (await repos.runs.listAll())[0];
		expect(row?.state).toBe("failed");
		expect(row?.failureReason).toBe("never_started");

		const payload = (await spawnFailedEvent(row?.id ?? ""))?.payloadJson as {
			message?: string;
			sandboxId?: string;
		};
		expect(payload.message).toContain("boom");
		// warren-1f56: `provider.create` collapses provision+dispatch and owns the
		// burrow-half rollback, so the domain never learns the burrow id on a
		// dispatch-step failure — the event elides it (the provider already
		// destroyed the burrow, so there is nothing stranded to reference).
		expect(payload.sandboxId).toBeUndefined();
	});
});
