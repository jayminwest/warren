import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	clearLifecycleBus,
	installLifecycleBus,
	LifecycleBus,
	type RunDispatchedPayload,
} from "../lifecycle-bus.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-4e74: `spawnRun` fires the observe-only `run_dispatched`
 * lifecycle hook through the boot-installed bus singleton, once per run,
 * after the burrow correlation ids are written back — and only when the
 * dispatch succeeds.
 */

function spy(): { bus: LifecycleBus; seen: RunDispatchedPayload[] } {
	const seen: RunDispatchedPayload[] = [];
	const bus = new LifecycleBus();
	bus.register({
		name: "spy",
		protocol: "warren-ext/v1",
		hooks: { run_dispatched: (env) => void seen.push(env.payload) },
	});
	return { bus, seen };
}

describe("spawnRun: run_dispatched lifecycle emit (warren-4e74)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		clearLifecycleBus();
		await db.close();
	});

	test("emits run_dispatched on the installed bus after a successful dispatch", async () => {
		const { bus, seen } = spy();
		installLifecycleBus(bus);

		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			trigger: "healer",
		});

		expect(seen).toHaveLength(1);
		const payload = seen[0] as RunDispatchedPayload;
		expect(payload.runId).toBe(result.run.id);
		expect(payload.trigger).toBe("healer");
		expect(payload.sandboxId).toBe(result.sandbox.id);
		expect(payload.providerRunId).toBe(result.sandboxRun.id);
		expect(payload.agentName).toBe("refactor-bot");
	});

	test("a failed dispatch does not emit run_dispatched", async () => {
		const { bus, seen } = spy();
		installLifecycleBus(bus);

		const provider = makeProvider(makeSandboxClient().client);
		provider.create = () => Promise.reject(new Error("dispatch boom"));
		await expect(
			spawnRun({
				repos,
				runtimeProvider: provider,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toThrow("dispatch boom");
		expect(seen).toHaveLength(0);
	});
});
