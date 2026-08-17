/**
 * `/readyz` disclosure contract (warren-51de / pl-b82d step 2).
 *
 * The readiness payload is rendered verbatim from each check's `message`,
 * so a degraded deploy is exactly when the endpoint is most tempted to
 * leak: driver text names the DB host/port/role, loader text names the
 * server's absolute paths, and the auth-strength probe used to publish
 * `WARREN_API_TOKEN.length`.
 *
 * This test drives every probe into its degraded branch at once and
 * asserts the whole serialized body against the disclosure rules. It is
 * deliberately written against the SERIALIZED body rather than the check
 * objects — that is what an operator-token holder (and, if the auth gate
 * is ever relaxed, anyone) actually receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Host has no bubblewrap — the bwrap probe degrades. */
const failingSpawn: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) return { stdout: "", stderr: "not found", exitCode: 127 };
	return { stdout: "", stderr: "", exitCode: 0 };
};

/** A pg connection failure, verbatim as the driver phrases it. */
const PG_FAILURE = "connect ECONNREFUSED 10.4.2.9:5432 — role warren, database warren";

function degradedDeps(db: WarrenDb): ServerDeps {
	return {
		repos: {
			agents: { listAll: async () => [{ name: "claude-code" }] },
			// The project clone is gone, so the real loader throws with the
			// absolute path in its message.
			projects: {
				listAll: async () => [{ id: "prj_acme", localPath: "/data/warren/projects/acme" }],
			},
			runs: {
				listByState: async () => {
					throw new Error(PG_FAILURE);
				},
			},
		},
		db,
		spawn: failingSpawn,
		workspaceGcTtlMs: 3_600_000,
		projectsConfig: { root: "/data/warren/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	} as unknown as ServerDeps;
}

describe("/readyz disclosure contract (warren-51de)", () => {
	const prevRuntime = process.env.WARREN_RUNTIME;
	const prevHost = process.env.WARREN_PREVIEW_HOST;
	const prevToken = process.env.WARREN_API_TOKEN;
	let db: WarrenDb | null = null;

	afterEach(async () => {
		restoreEnv("WARREN_RUNTIME", prevRuntime);
		restoreEnv("WARREN_PREVIEW_HOST", prevHost);
		restoreEnv("WARREN_API_TOKEN", prevToken);
		await db?.close();
		db = null;
	});

	async function degradedBody(): Promise<{ raw: string; checks: ReadonlyArray<ReadyzCheck> }> {
		process.env.WARREN_RUNTIME = "local";
		process.env.WARREN_PREVIEW_HOST = "preview.example.com";
		process.env.WARREN_API_TOKEN = "short";
		db = await openDatabase({ path: ":memory:" });
		const res = await readyzHandler(degradedDeps(db))({} as RouteContext);
		expect(res.status).toBe(503);
		const raw = await res.text();
		return { raw, checks: (JSON.parse(raw) as { checks: ReadyzCheck[] }).checks };
	}

	test("the token check never discloses a length", async () => {
		const { checks } = await degradedBody();
		const auth = checks.find((c) => c.name === "preview_auth_strength");
		expect(auth?.ok).toBe(false);
		expect(auth?.message ?? "").not.toMatch(/[0-9]{2,}/);
	});

	test("no absolute filesystem path reaches the body", async () => {
		const { raw } = await degradedBody();
		expect(raw).not.toContain("/data/");
	});

	test("no DB host, port or role reaches the body", async () => {
		const { raw } = await degradedBody();
		expect(raw).not.toContain("10.4.2.9");
		expect(raw).not.toContain("5432");
		expect(raw).not.toContain("ECONNREFUSED");
	});

	test("every degraded check still names what is wrong via a stable reason", async () => {
		const { checks } = await degradedBody();
		const byName = new Map(checks.map((c) => [c.name, c]));
		expect(byName.get("stale_sandbox_workspaces")?.message).toBe(
			"probe failed (reason=unreachable)",
		);
		expect(byName.get("warren_config")?.message).toContain("prj_acme: warren_config_unavailable");
		// Failing checks keep their recovery hint — the reason code replaces the
		// leaked detail, it does not replace the operator's next action.
		for (const check of checks) {
			if (!check.ok) expect(check.hint ?? "").not.toBe("");
		}
	});
});

interface ReadyzCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

function restoreEnv(key: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[key];
	else process.env[key] = previous;
}
