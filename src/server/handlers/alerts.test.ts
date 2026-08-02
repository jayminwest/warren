import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeBurrowClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const SENTRY_PAYLOAD = {
	data: {
		issue: { id: "issue-99" },
		event: { title: "TypeError in finalize", culprit: "src/runs/reap.ts" },
	},
	url: "https://sentry.io/org/x/",
};

async function writeHealerConfig(projectPath: string, body: string): Promise<void> {
	await mkdir(join(projectPath, ".warren"), { recursive: true });
	await writeFile(join(projectPath, ".warren", "config.yaml"), body);
}

describe("POST /alerts/heal", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "healer",
			renderedJson: {
				name: "healer",
				version: 1,
				sections: { system: "you are the healer" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-heal-proj-"));
		await repos.projects.create({
			gitUrl: "https://github.com/jayminwest/warren.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serve(): Promise<void> {
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-heal-ws-"));
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_heal0000000", burrowRunId: "run_healrun00000", workspacePath: tmpWs },
			[],
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
	}

	async function post(payload: unknown, source = "sentry"): Promise<Response> {
		if (handle === null) throw new Error("handle missing");
		return fetch(`${tcpUrl(handle)}/alerts/heal?source=${source}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
	}

	test("dispatches a healer run for a mapped, enabled project (202)", async () => {
		await writeHealerConfig(
			projectLocalPath,
			"healer:\n  enabled: true\n  projectMapping:\n    - issue-99\n",
		);
		await serve();

		const res = await post(SENTRY_PAYLOAD);
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			status: string;
			runId: string;
			fingerprint: string;
			projectId: string;
		};
		expect(body.status).toBe("dispatched");
		expect(body.fingerprint).toBe("issue-99");
		expect(body.runId).toMatch(/^run_/);

		const run = await repos.runs.require(body.runId);
		expect(run.trigger).toBe("healer");
		expect(run.agentName).toBe("healer");

		// The durable heal.dispatched event is stamped for idempotency.
		const events = await repos.events.listByKind("heal.dispatched");
		expect(events.length).toBe(1);
		expect((events[0]?.payloadJson as { fingerprint?: string })?.fingerprint).toBe("issue-99");
	});

	test("routes via the repo payload fallback when no mapping key matches", async () => {
		await writeHealerConfig(projectLocalPath, "healer:\n  enabled: true\n");
		await serve();

		// No projectMapping, but the alert's repo matches the project git URL.
		const res = await post({
			data: { issue: { id: "issue-repo" } },
			repository: "https://github.com/jayminwest/warren",
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("dispatched");
	});

	test("skips with cooldown on a second identical alert (202 dispatch then 200 skip)", async () => {
		await writeHealerConfig(
			projectLocalPath,
			"healer:\n  enabled: true\n  projectMapping:\n    - issue-99\n",
		);
		await serve();

		expect((await post(SENTRY_PAYLOAD)).status).toBe(202);

		const second = await post(SENTRY_PAYLOAD);
		expect(second.status).toBe(200);
		const body = (await second.json()) as { status: string; reason: string };
		expect(body.status).toBe("skipped");
		expect(body.reason).toBe("cooldown");
	});

	test("holds the cap per fingerprint past 500 unrelated heal.dispatched events", async () => {
		// warren-55cf: the attempt history used to come from the 500 newest
		// heal.dispatched rows globally, so a noisy fleet scrolled an exhausted
		// fingerprint out of the window and the cooldown silently reset.
		await writeHealerConfig(
			projectLocalPath,
			"healer:\n  enabled: true\n  maxRetries: 1\n  projectMapping:\n    - issue-99\n",
		);
		await serve();

		const first = await post(SENTRY_PAYLOAD);
		expect(first.status).toBe(202);
		const { runId } = (await first.json()) as { runId: string };

		for (let i = 0; i < 600; i++) {
			await repos.events.append({
				runId,
				burrowEventSeq: 10_000 + i,
				ts: `2099-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
				kind: "heal.dispatched",
				payload: { fingerprint: `fp-noise-${i}`, source: "sentry", title: "noise" },
			});
		}
		// The bounded window no longer holds the target fingerprint at all.
		const windowed = await repos.events.listByKind("heal.dispatched");
		expect(
			windowed.some((r) => (r.payloadJson as { fingerprint?: string }).fingerprint === "issue-99"),
		).toBe(false);

		const second = await post(SENTRY_PAYLOAD);
		expect(second.status).toBe(200);
		const body = (await second.json()) as { status: string; reason: string };
		expect(body.status).toBe("skipped");
		expect(body.reason).toBe("max_retries");
	});

	test("skips with no_match when nothing routes (200)", async () => {
		await writeHealerConfig(
			projectLocalPath,
			"healer:\n  enabled: true\n  projectMapping:\n    - some-other-key\n",
		);
		await serve();

		const res = await post({
			data: { issue: { id: "unrouted" }, event: { title: "elsewhere" } },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; reason: string };
		expect(body.status).toBe("skipped");
		expect(body.reason).toBe("no_match");
	});

	test("skips with disabled when the matched project is opted out (200)", async () => {
		await writeHealerConfig(
			projectLocalPath,
			"healer:\n  enabled: false\n  projectMapping:\n    - issue-99\n",
		);
		await serve();

		const res = await post(SENTRY_PAYLOAD);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; reason: string };
		expect(body.reason).toBe("disabled");
	});

	test("rejects an invalid ?source with 400", async () => {
		await serve();
		const res = await post(SENTRY_PAYLOAD, "datadog");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});
});
