import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Env, loadConfig } from "../config.ts";
import { FakeGitHub } from "../fake-github.ts";
import { GitHubClient } from "../github/client.ts";
import type { Fetch } from "../github/transport.ts";
import { loadDispatchConfig } from "./config.ts";
import { QueueController } from "./controller.ts";
import { DispatchStore } from "./store.ts";
import { WarrenClient } from "./warren.ts";

const dirs: string[] = [];
const stores: DispatchStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(overrides: Env = {}) {
	const dir = mkdtempSync(join(tmpdir(), "github-queue-"));
	dirs.push(dir);
	const config = loadDispatchConfig({
		AUTO_DISPATCH_ENABLED: "true",
		TRACKER_BEARER: "test-bearer",
		WARREN_BASE_URL: "http://127.0.0.1:8080",
		WARREN_API_TOKEN: "warren-test-secret",
		WARREN_AGENT: "pi",
		WARREN_PROJECT_MAP: '{"acme/web":"prj_one"}',
		AUTO_STATE_PATH: join(dir, "state.sqlite"),
		AUTO_MAX_COST_USD: "2",
		AUTO_DAILY_BUDGET_USD: "4",
		...overrides,
	});
	if (!config) throw new Error("fixture missing config");
	const store = new DispatchStore(config.database);
	stores.push(store);
	const fake = new FakeGitHub();
	const github = new GitHubClient(
		loadConfig({ GITHUB_TOKEN: "test-secret", GITHUB_REPOSITORY: "acme/web" }),
		fake.fetch,
	);
	return { config, store, fake, github };
}
function fakeWarren(
	options: { ambiguous?: boolean; terminal?: boolean; wrongRepo?: boolean; status?: number } = {},
) {
	const calls: string[] = [];
	const fetch: Fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		calls.push(`${init?.method ?? "GET"} ${path}`);
		if (path === "/projects/prj_one")
			return Response.json({
				gitUrl: `https://github.com/acme/${options.wrongRepo ? "other" : "web"}.git`,
			});
		if (path.endsWith("/dispatch")) {
			if (options.ambiguous) throw new Error("connection lost after acceptance");
			if (options.status) return new Response("refused", { status: options.status });
			return Response.json({ run: { id: "run_one", state: "running", costUsd: 0 } });
		}
		return Response.json({
			run: { id: "run_one", state: options.terminal ? "succeeded" : "running", costUsd: 1 },
		});
	};
	return { fetch, calls };
}

describe("QueueController", () => {
	test("does not configure automation unless explicitly enabled and requires budgets, credentials and repository mapping", () => {
		expect(loadDispatchConfig({})).toBeUndefined();
		expect(() => loadDispatchConfig({ AUTO_DISPATCH_ENABLED: "yes" })).toThrow();
		expect(() => loadDispatchConfig({ AUTO_DISPATCH_ENABLED: "true" })).toThrow();
	});

	test("dispatches once, polls the known run, and never repeats after restart or completion", async () => {
		const s = setup();
		const w = fakeWarren({ terminal: true });
		await new QueueController(
			s.config,
			s.github,
			new WarrenClient(s.config, w.fetch),
			s.store,
		).tick();
		const restarted = new DispatchStore(s.config.database);
		stores.push(restarted);
		await new QueueController(
			s.config,
			s.github,
			new WarrenClient(s.config, w.fetch),
			restarted,
		).tick();
		expect(w.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
		expect(restarted.list()[0]?.state).toBe("settled");
	});

	test("keeps uncertain mutations durable and never retries them", async () => {
		const s = setup({ AUTO_MAX_CONCURRENT: "2" });
		const w = fakeWarren({ ambiguous: true });
		s.fake.issues.push({ number: 2, repository: "acme/web" });
		const controller = new QueueController(
			s.config,
			s.github,
			new WarrenClient(s.config, w.fetch),
			s.store,
		);
		await expect(controller.tick()).rejects.toMatchObject({ code: "warren_uncertain" });
		await controller.tick();
		expect(w.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
		expect(s.store.list()[0]?.state).toBe("uncertain");
	});

	test("enforces concurrency and daily reservations across separate store connections", () => {
		const s = setup();
		const second = new DispatchStore(s.config.database);
		stores.push(second);
		const now = Date.parse("2026-09-09T12:00:00Z");
		expect(s.store.reserve("acme/web#1", "prj_one", 2, 4, 1, now)).toBe(true);
		expect(second.reserve("acme/web#1", "prj_one", 2, 4, 1, now)).toBe(false);
		expect(second.reserve("acme/web#2", "prj_one", 2, 4, 1, now)).toBe(false);
		s.store.record("acme/web#1", "settled", "run_one", null, 1);
		expect(second.reserve("acme/web#2", "prj_one", 2, 4, 1, now)).toBe(true);
		s.store.record("acme/web#2", "settled", "run_two", null, 1);
		expect(second.reserve("acme/web#3", "prj_one", 2, 4, 1, now)).toBe(false);
		expect(second.reserve("acme/web#3", "prj_one", 2, 4, 1, now + 86400000)).toBe(true);
	});

	test("refuses wrong-repository dispatch and skips unmapped repositories", async () => {
		const s = setup();
		const w = fakeWarren({ wrongRepo: true });
		await expect(
			new QueueController(s.config, s.github, new WarrenClient(s.config, w.fetch), s.store).tick(),
		).rejects.toMatchObject({ code: "repository_mismatch" });
		expect(w.calls.some((call) => call.startsWith("POST"))).toBe(false);
		expect(s.store.list()).toHaveLength(0);
	});

	test("does not turn a failed run poll into a new dispatch", async () => {
		const s = setup();
		s.store.reserve("acme/web#1", "prj_one", 2, 4, 1, Date.now());
		s.store.record("acme/web#1", "running", "run_one");
		const w = new WarrenClient(s.config, async () => new Response("unavailable", { status: 503 }));
		await expect(new QueueController(s.config, s.github, w, s.store).tick()).rejects.toMatchObject({
			code: "warren_read_failed",
		});
		expect(s.store.list()[0]?.state).toBe("running");
	});

	test("records a definite refusal without repeatedly retrying paid work", async () => {
		const s = setup();
		const w = fakeWarren({ status: 422 });
		const c = new QueueController(s.config, s.github, new WarrenClient(s.config, w.fetch), s.store);
		await expect(c.tick()).rejects.toMatchObject({ code: "warren_rejected" });
		await c.tick();
		expect(s.store.list()[0]?.state).toBe("rejected");
		expect(w.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
	});
});
