import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AnyWarrenDb, openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { BASE_CONFIG, fakeSidecars } from "./test-helpers.ts";
import { startPreviewEvictionWorker } from "./worker.ts";

describe("startPreviewEvictionWorker", () => {
	let db: AnyWarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("runOnce fires the tick and increments tick count", async () => {
		const sidecars = fakeSidecars();
		const configs = createWarrenConfigCache({
			load: async () => ({
				triggers: null,
				defaults: null,
				prTemplate: null,
				sourceFile: null,
				errors: [],
				warnings: [],
			}),
		});
		const handle = startPreviewEvictionWorker({
			db,
			repos,
			burrowClientPool: undefined as never,
			warrenConfigs: configs,
			config: { ...BASE_CONFIG, disabled: true },
			resolveSidecar: sidecars.resolver,
		});

		const result = await handle.runOnce();
		expect(result).not.toBeNull();
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("disabled mode skips setInterval", async () => {
		let timersStarted = 0;
		const handle = startPreviewEvictionWorker({
			db,
			repos,
			burrowClientPool: undefined as never,
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			config: { ...BASE_CONFIG, disabled: true },
			setInterval: () => {
				timersStarted += 1;
				return {};
			},
			clearInterval: () => {},
		});
		expect(timersStarted).toBe(0);
		await handle.stop();
	});
});
