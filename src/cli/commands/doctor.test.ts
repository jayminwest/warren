import { describe, expect, test } from "bun:test";
import type { CliContext, CliSpawn, EnvLike } from "../output.ts";
import { type DoctorCheck, runDoctor } from "./doctor.ts";

function captureContext(
	env: EnvLike = {},
	spawn: CliSpawn = async () => ({ stdout: "", stderr: "", exitCode: 0 }),
): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env,
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn,
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

describe("runDoctor", () => {
	test("flags missing WARREN_API_TOKEN and exits 1; CANOPY_REPO_URL is informational", async () => {
		const { context } = captureContext({});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const tokenCheck = result.checks.find((c: DoctorCheck) => c.name === "WARREN_API_TOKEN");
		expect(tokenCheck?.ok).toBe(false);
		// CANOPY_REPO_URL is now optional (warren-d3e9): unset is ok with an
		// informational message, not a failure.
		const canopyCheck = result.checks.find((c: DoctorCheck) => c.name === "CANOPY_REPO_URL");
		expect(canopyCheck?.ok).toBe(true);
		expect(canopyCheck?.message).toContain("no canopy library configured");
	});

	test("doctor passes with no canopy library configured (warren-d3e9)", async () => {
		const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(0);
		expect(result.checks.every((c: DoctorCheck) => c.ok)).toBe(true);
	});

	test("--no-auth exempts the WARREN_API_TOKEN check", async () => {
		const { context } = captureContext({
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{ noAuth: true },
		);
		const tokenCheck = result.checks.find((c: DoctorCheck) => c.name === "WARREN_API_TOKEN");
		expect(tokenCheck?.ok).toBe(true);
		expect(tokenCheck?.message).toBe("skipped (--no-auth)");
		expect(result.exitCode).toBe(0);
	});

	test("flags an unreachable burrow with the probe error message", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => {
					throw new Error("ECONNREFUSED /var/run/burrow.sock");
				},
			},
			{},
		);
		const burrowCheck = result.checks.find((c: DoctorCheck) => c.name === "burrow_reachable");
		expect(burrowCheck?.ok).toBe(false);
		expect(burrowCheck?.message).toContain("ECONNREFUSED");
		expect(result.exitCode).toBe(1);
	});

	test("flags a missing canopy clone directory", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
			WARREN_CANOPY_DIR: "/nonexistent/canopy",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: (p) => p !== "/nonexistent/canopy",
				probeBurrow: async () => undefined,
			},
			{},
		);
		const canopyClone = result.checks.find((c: DoctorCheck) => c.name === "canopy_clone");
		expect(canopyClone?.ok).toBe(false);
		expect(canopyClone?.message).toContain("/nonexistent/canopy");
	});

	test("returns exit 0 when every check passes", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(0);
		expect(result.checks.every((c: DoctorCheck) => c.ok)).toBe(true);
	});

	test("flags a missing bwrap binary with the install hint", async () => {
		const { context } = captureContext(
			{
				WARREN_API_TOKEN: "tok",
				CANOPY_REPO_URL: "https://example.com/agents.git",
			},
			async (cmd) => {
				if (cmd[0]?.endsWith("bwrap")) {
					return { stdout: "", stderr: "command not found", exitCode: 127 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		);
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const bwrap = result.checks.find((c: DoctorCheck) => c.name === "bwrap");
		expect(bwrap?.ok).toBe(false);
		expect(bwrap?.hint).toContain("bubblewrap");
	});

	test("flags a dirty canopy clone with the refresh hint", async () => {
		const { context } = captureContext(
			{
				WARREN_API_TOKEN: "tok",
				CANOPY_REPO_URL: "https://example.com/agents.git",
			},
			async (cmd) => {
				if (cmd.includes("status") && cmd.includes("--porcelain")) {
					return { stdout: " M agents/foo.md\n", stderr: "", exitCode: 0 };
				}
				return { stdout: "bubblewrap 0.8.0", stderr: "", exitCode: 0 };
			},
		);
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const clean = result.checks.find((c: DoctorCheck) => c.name === "canopy_clean");
		expect(clean?.ok).toBe(false);
		expect(clean?.message).toContain("1 local mutation");
		expect(clean?.hint).toContain("/agents/refresh");
	});

	test("emits all expected check names in order", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		const names = result.checks.map((c) => c.name);
		expect(names).toEqual([
			"WARREN_API_TOKEN",
			"CANOPY_REPO_URL",
			"warren_db",
			"db_reachable",
			"canopy_clone",
			"canopy_clean",
			"projects_root",
			"bwrap",
			"warren_config",
			"warren_config_deprecations",
			"preview_port_allocator",
			"stale_burrow_workspaces",
			"preview_auth_strength",
			"burrow_reachable",
		]);
	});

	test("warren_db reports the resolved dialect for WARREN_DB_URL", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			WARREN_DB_URL: "postgres://u:p@host/db",
		});
		const result = await runDoctor(
			context,
			{ existsSync: () => true, probeBurrow: async () => undefined },
			{},
		);
		const dbCheck = result.checks.find((c: DoctorCheck) => c.name === "warren_db");
		expect(dbCheck?.ok).toBe(true);
		expect(dbCheck?.message).toBe("postgres");
	});

	test("warren_db flags a WARREN_DB_URL/WARREN_DB_PATH conflict", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			WARREN_DB_URL: "postgres://h/db",
			WARREN_DB_PATH: "/srv/warren.sqlite",
		});
		const result = await runDoctor(
			context,
			{ existsSync: () => true, probeBurrow: async () => undefined },
			{},
		);
		const dbCheck = result.checks.find((c: DoctorCheck) => c.name === "warren_db");
		expect(dbCheck?.ok).toBe(false);
		expect(dbCheck?.message).toContain("disagree");
		expect(result.exitCode).toBe(1);
	});

	test("db_reachable degrades to informational ok when no db handle is wired", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{ existsSync: () => true, probeBurrow: async () => undefined },
			{},
		);
		const db = result.checks.find((c: DoctorCheck) => c.name === "db_reachable");
		expect(db?.ok).toBe(true);
		expect(db?.message).toContain("no db handle wired");
	});

	test("db_reachable pings a live sqlite handle and reports the dialect", async () => {
		const { openDatabase } = await import("../../db/client.ts");
		const db = await openDatabase({ url: ":memory:" });
		try {
			const { context } = captureContext({
				WARREN_API_TOKEN: "tok",
				CANOPY_REPO_URL: "https://example.com/agents.git",
			});
			const result = await runDoctor(
				context,
				{ existsSync: () => true, probeBurrow: async () => undefined, db },
				{},
			);
			const reach = result.checks.find((c: DoctorCheck) => c.name === "db_reachable");
			expect(reach?.ok).toBe(true);
			expect(reach?.message).toBe("dialect=sqlite");
		} finally {
			await db.close();
		}
	});

	test("warren_config is ok with no projects registered", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		const wc = result.checks.find((c: DoctorCheck) => c.name === "warren_config");
		expect(wc?.ok).toBe(true);
		expect(wc?.message).toContain("no projects registered");
	});
});
