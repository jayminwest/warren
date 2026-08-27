import { describe, expect, test } from "bun:test";
import type { AnyWarrenDb } from "../../db/client.ts";
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
	test("flags missing WARREN_API_TOKEN and exits 1", async () => {
		const { context } = captureContext({});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const tokenCheck = result.checks.find((c: DoctorCheck) => c.name === "WARREN_API_TOKEN");
		expect(tokenCheck?.ok).toBe(false);
	});

	test("doctor passes with no canopy library configured (warren-d3e9)", async () => {
		const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
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
				probeLocalRuntime: async () => undefined,
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
				probeLocalRuntime: async () => {
					throw new Error("ECONNREFUSED /var/run/burrow.sock");
				},
			},
			{},
		);
		const sandboxCheck = result.checks.find((c: DoctorCheck) => c.name === "local_runtime");
		expect(sandboxCheck?.ok).toBe(false);
		expect(sandboxCheck?.message).toContain("ECONNREFUSED");
		expect(result.exitCode).toBe(1);
	});

	test("returns exit 0 when every check passes", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
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
				probeLocalRuntime: async () => undefined,
				platform: "linux",
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const bwrap = result.checks.find((c: DoctorCheck) => c.name === "bwrap");
		expect(bwrap?.ok).toBe(false);
		expect(bwrap?.hint).toContain("bubblewrap");
	});

	test("emits all expected check names in order", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
			},
			{},
		);
		const names = result.checks.map((c) => c.name);
		expect(names).toEqual([
			"WARREN_API_TOKEN",
			"git_identity",
			"warren_db",
			"db_reachable",
			"projects_root",
			"bwrap",
			"warren_config",
			"warren_config_deprecations",
			"preview_port_allocator",
			"stale_sandbox_workspaces",
			"preview_auth_strength",
			"local_runtime",
		]);
	});

	test("under WARREN_RUNTIME=k8s, skips burrow/bwrap/stale probes and says so", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
			WARREN_RUNTIME: "k8s",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				// A throwing probe would fail the check under local; under k8s it must
				// never be consulted at all.
				probeLocalRuntime: async () => {
					throw new Error("burrow must not be probed under k8s");
				},
			},
			{},
		);
		const names = result.checks.map((c) => c.name);
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("stale_sandbox_workspaces");
		expect(names).not.toContain("local_runtime");
		const runtime = result.checks.find((c: DoctorCheck) => c.name === "runtime_backend");
		expect(runtime?.ok).toBe(true);
		expect(runtime?.message).toContain("k8s");
		expect(result.exitCode).toBe(0);
	});

	// warren-1219: the sandbox git preflight check runs only on the local
	// topology, only when a probe is wired (main.ts wires the real one).
	test("sandbox_git check reports ok for a passing probe", async () => {
		const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
				probeSandboxGit: async () => ({
					ok: true,
					gitPath: "/usr/bin/git",
					effectiveGit: "/usr/bin/git",
					substituted: false,
					message: "/usr/bin/git executes inside the sandbox profile (git --version ok)",
				}),
			},
			{},
		);
		const check = result.checks.find((c: DoctorCheck) => c.name === "sandbox_git");
		expect(check?.ok).toBe(true);
		expect(check?.message).toContain("git --version");
		expect(result.exitCode).toBe(0);
	});

	test("sandbox_git check fails (and fails doctor) naming the binary for a broken sandbox git", async () => {
		const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeLocalRuntime: async () => undefined,
				probeSandboxGit: async () => ({
					ok: false,
					gitPath: "/nix/store/abc-git-2.44/bin/git",
					effectiveGit: "/nix/store/abc-git-2.44/bin/git",
					substituted: false,
					message:
						"/nix/store/abc-git-2.44/bin/git does not execute inside the sandbox: dyld: Library not loaded",
					hint: "this git cannot run inside the sandbox; install a system git",
				}),
			},
			{},
		);
		const check = result.checks.find((c: DoctorCheck) => c.name === "sandbox_git");
		expect(check?.ok).toBe(false);
		expect(check?.message).toContain("/nix/store/abc-git-2.44/bin/git");
		expect(check?.message).toContain("dyld");
		expect(check?.hint).toContain("sandbox");
		expect(result.exitCode).toBe(1);
	});

	test("sandbox_git check is absent without a wired probe (hermetic default)", async () => {
		const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
		const result = await runDoctor(
			context,
			{ existsSync: () => true, probeLocalRuntime: async () => undefined },
			{},
		);
		expect(result.checks.map((c) => c.name)).not.toContain("sandbox_git");
	});

	test("warren_db reports the resolved dialect for WARREN_DB_URL", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			WARREN_DB_URL: "postgres://u:p@host/db",
		});
		const result = await runDoctor(
			context,
			{ existsSync: () => true, probeLocalRuntime: async () => undefined },
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
			{ existsSync: () => true, probeLocalRuntime: async () => undefined },
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
			{ existsSync: () => true, probeLocalRuntime: async () => undefined },
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
				{ existsSync: () => true, probeLocalRuntime: async () => undefined, db },
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
				probeLocalRuntime: async () => undefined,
			},
			{},
		);
		const wc = result.checks.find((c: DoctorCheck) => c.name === "warren_config");
		expect(wc?.ok).toBe(true);
		expect(wc?.message).toContain("no projects registered");
	});

	describe("--verbose (warren-2d14)", () => {
		// A db handle whose SELECT 1 fails with text that names host/role —
		// exactly the disclosure warren-51de keeps off the check message.
		const RAW_DRIVER_TEXT = "ECONNREFUSED 10.0.0.9:5432 role warren_admin";
		const failingDb = (): AnyWarrenDb =>
			({
				dialect: "sqlite",
				raw: {
					query: () => ({
						get: () => {
							throw new Error(RAW_DRIVER_TEXT);
						},
					}),
				},
				drizzle: {},
				close: async () => {},
			}) as unknown as AnyWarrenDb;

		test("writes the raw driver text to stderr while the check message keeps the reason code", async () => {
			const { context, err } = captureContext({ WARREN_API_TOKEN: "tok" });
			const result = await runDoctor(
				context,
				{ existsSync: () => true, probeLocalRuntime: async () => undefined, db: failingDb() },
				{ verbose: true },
			);
			const reach = result.checks.find((c: DoctorCheck) => c.name === "db_reachable");
			expect(reach?.ok).toBe(false);
			expect(reach?.message).toBe("probe failed (reason=unreachable)");
			expect(reach?.message).not.toContain(RAW_DRIVER_TEXT);
			expect(err.join("")).toContain("warren doctor verbose:");
			expect(err.join("")).toContain(RAW_DRIVER_TEXT);
		});

		test("default output drops the raw driver text entirely (unchanged behavior)", async () => {
			const { context, err } = captureContext({ WARREN_API_TOKEN: "tok" });
			const result = await runDoctor(
				context,
				{ existsSync: () => true, probeLocalRuntime: async () => undefined, db: failingDb() },
				{},
			);
			const reach = result.checks.find((c: DoctorCheck) => c.name === "db_reachable");
			expect(reach?.ok).toBe(false);
			expect(reach?.message).toBe("probe failed (reason=unreachable)");
			expect(err.join("")).not.toContain(RAW_DRIVER_TEXT);
		});
	});

	describe("git_identity check (warren-e7b7)", () => {
		test("warns on unset WARREN_GIT_AUTHOR_* (ok:true — a warning, not a failure)", async () => {
			const { context } = captureContext({ WARREN_API_TOKEN: "tok" });
			const result = await runDoctor(
				context,
				{ existsSync: () => true, probeLocalRuntime: async () => undefined },
				{},
			);
			const check = result.checks.find((c: DoctorCheck) => c.name === "git_identity");
			expect(check?.ok).toBe(true);
			expect(check?.message).toContain("warning");
			expect(check?.hint).toContain("machine account");
			expect(result.exitCode).toBe(0);
		});

		test("reports configured when both WARREN_GIT_AUTHOR_* vars are set", async () => {
			const { context } = captureContext({
				WARREN_API_TOKEN: "tok",
				WARREN_GIT_AUTHOR_NAME: "warren-bot",
				WARREN_GIT_AUTHOR_EMAIL: "12345+warren-bot@users.noreply.github.com",
			});
			const result = await runDoctor(
				context,
				{ existsSync: () => true, probeLocalRuntime: async () => undefined },
				{},
			);
			const check = result.checks.find((c: DoctorCheck) => c.name === "git_identity");
			expect(check?.ok).toBe(true);
			expect(check?.message).toContain("configured");
			expect(check?.hint).toBeUndefined();
		});
	});
});
