/**
 * Scenario 11 — `warren doctor` exit codes (README CLI docs / `warren doctor --help`).
 *
 * Acceptance criterion #11:
 *   "warren doctor exits 0 when the host is healthy, exits non-zero
 *   with a hint when something is broken."
 *
 * Doctor probes (mx-1a70ef, post-R-02):
 *   WARREN_API_TOKEN, projects_root, bwrap, warren_config,
 *   burrow_reachable.
 * The shared check functions live in src/diagnostics/checks.ts so this
 * scenario tests the same surface /readyz exposes (mx-718b25). Scenario
 * 14 covers the warren_config-with-real-projects matrix; here we only
 * assert the check is present and `ok: true` against the empty-projects
 * baseline (the "no projects registered" branch).
 *
 * Two invocations, each spawning `bun run src/cli/main.ts doctor` as a
 * child process so we exercise the real exit code path:
 *
 *  A. Healthy — `--no-auth` exempts the token check, a fake bwrap
 *     shim on PATH satisfies the bwrap probe on dev hosts where
 *     bubblewrap isn't installed, and
 *     WARREN_BURROW_SOCKET points at the harness's running burrow.
 *     Expected: exit 0, every check `ok: true`.
 *
 *  B. Broken — same env shape but WARREN_BURROW_SOCKET points at a
 *     non-existent path so the burrow_reachable probe fails. Expected:
 *     exit 1, burrow_reachable.ok=false with a hint mentioning the
 *     socket env var.
 *
 * The bwrap shim is necessary because dev/CI hosts (notably macOS) do
 * not ship bubblewrap, and warren's production doctor invokes the
 * literal `bwrap --version` binary on PATH (no env override). The shim
 * approach mirrors how the production image relies on its base layer
 * (mx-689d86) to put bwrap on PATH.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";

interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

interface DoctorRun {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
	readonly stdout: string;
	readonly stderr: string;
}

const EXPECTED_CHECK_NAMES: readonly string[] = [
	"WARREN_API_TOKEN",
	"projects_root",
	"bwrap",
	"warren_config",
	"burrow_reachable",
];

export const scenario: Scenario = {
	id: "11",
	title:
		"warren doctor exits 0 healthy, exits non-zero with hint when burrow socket is unreachable",
	modes: ["in-proc"],
	async run(ctx) {
		const scratch = join(ctx.tmp, "scenario-11");
		await mkdir(scratch, { recursive: true });
		const shimDir = await writeBwrapShim(scratch);

		try {
			const baseEnv = buildDoctorEnv(ctx, shimDir);

			// A — healthy: real socket, fake-but-passing bwrap, no canopy library.
			const healthy = await runDoctor(baseEnv);
			ctx.logger.debug(
				`scenario-11 healthy doctor: exit=${healthy.exitCode} checks=${healthy.checks.length}`,
			);
			assertEqual(healthy.exitCode, 0, "healthy doctor exits 0");
			assertEqual(
				healthy.checks.length,
				EXPECTED_CHECK_NAMES.length,
				"healthy doctor emits the seven canonical checks",
			);
			for (const expected of EXPECTED_CHECK_NAMES) {
				const found = healthy.checks.find((c) => c.name === expected);
				if (found === undefined) {
					throw new AcceptanceError(
						`healthy doctor missing check ${expected}; got [${healthy.checks
							.map((c) => c.name)
							.join(", ")}]`,
					);
				}
				if (!found.ok) {
					throw new AcceptanceError(
						`healthy doctor: check ${expected} is not ok — message=${JSON.stringify(found.message)} hint=${JSON.stringify(found.hint)} (stderr=${healthy.stderr.trim()})`,
					);
				}
			}

			// B — broken: point WARREN_BURROW_SOCKET at a path that doesn't exist.
			const brokenSocket = join(scratch, "definitely-not-here.sock");
			const broken = await runDoctor({
				...baseEnv,
				WARREN_BURROW_SOCKET: brokenSocket,
			});
			ctx.logger.debug(
				`scenario-11 broken doctor: exit=${broken.exitCode} checks=${broken.checks.length}`,
			);
			assertTrue(broken.exitCode !== 0, `broken doctor must exit non-zero; got ${broken.exitCode}`);
			const burrowCheck = broken.checks.find((c) => c.name === "burrow_reachable");
			if (burrowCheck === undefined) {
				throw new AcceptanceError(
					`broken doctor missing burrow_reachable check; got [${broken.checks
						.map((c) => c.name)
						.join(", ")}]`,
				);
			}
			assertEqual(
				burrowCheck.ok,
				false,
				"broken doctor: burrow_reachable.ok is false when socket is unreachable",
			);
			const hint = burrowCheck.hint ?? "";
			assertTrue(
				hint.length > 0,
				`broken doctor: burrow_reachable check must carry a recovery hint; got ${JSON.stringify(burrowCheck)}`,
			);
			assertTrue(
				hint.includes("WARREN_BURROW_SOCKET") || hint.includes("burrow"),
				`broken doctor: hint should reference the socket env var or burrow; got ${JSON.stringify(hint)}`,
			);

			// The non-burrow probes that don't depend on the socket should
			// still report ok=true — surfaces that doctor doesn't bail on
			// the first failure but reports every check.
			const otherChecks = broken.checks.filter((c) => c.name !== "burrow_reachable");
			for (const c of otherChecks) {
				if (!c.ok) {
					throw new AcceptanceError(
						`broken doctor: only burrow_reachable should fail; ${c.name} also reported ok=false (message=${JSON.stringify(c.message)})`,
					);
				}
			}

			// Stderr carries the canonical 'one or more checks failed' banner
			// for the broken case (operator-visible cue beyond the exit code).
			assertTrue(
				broken.stderr.includes("one or more checks failed"),
				`broken doctor stderr should advise the operator; got ${JSON.stringify(broken.stderr)}`,
			);
		} finally {
			await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	},
};

function buildDoctorEnv(ctx: ScenarioCtx, shimDir: string): Record<string, string> {
	const passthrough: Record<string, string> = {};
	for (const k of ["HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "TZ"]) {
		const v = process.env[k];
		if (typeof v === "string") passthrough[k] = v;
	}
	const parentPath = process.env.PATH ?? "";
	return {
		...passthrough,
		PATH: `${shimDir}:${parentPath}`,
		// `--no-auth` exempts the token check, but doctor still emits the
		// 'skipped' message for it; healthy assertion treats that as ok.
		// Leaving the env var unset keeps the shape simple.
		WARREN_BURROW_SOCKET: ctx.socketPath,
		// Setting WARREN_PROJECTS_DIR keeps projects_root pointing somewhere
		// inside our scratch tree rather than /data/projects.
		WARREN_PROJECTS_DIR: join(ctx.tmp, "scenario-11", "projects-root"),
		// Doctor wraps in `withCliDb` (warren-3151) so the warren_config
		// check can walk every registered project. The default DB path is
		// /data/warren.db, which doesn't exist on macOS dev hosts —
		// pointing at a scratch path makes openDatabase mkdirp the parent
		// and create an empty DB. With no projects registered, the
		// warren_config check reports `ok: true` ("no projects registered")
		// and doctor still exits 0.
		WARREN_DB_PATH: join(ctx.tmp, "scenario-11", "warren.db"),
	};
}

async function writeBwrapShim(scratchDir: string): Promise<string> {
	// Doctor calls `bwrap --version` literally; the shim only needs to
	// exit 0 and print something to stdout so checkBwrap's success branch
	// records a message. macOS dev hosts otherwise fail the probe.
	const shimDir = join(scratchDir, "bin");
	await mkdir(shimDir, { recursive: true });
	const shimPath = join(shimDir, "bwrap");
	await writeFile(shimPath, "#!/usr/bin/env bash\nprintf 'bwrap 0.99.0-acceptance\\n'\nexit 0\n");
	await chmod(shimPath, 0o755);
	return shimDir;
}

async function runDoctor(env: Record<string, string>): Promise<DoctorRun> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/cli/main.ts", "doctor", "--no-auth"],
		cwd: process.cwd(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const checks: DoctorCheck[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as DoctorCheck;
			if (typeof parsed.name === "string" && typeof parsed.ok === "boolean") {
				checks.push(parsed);
			}
		} catch (err) {
			throw new AcceptanceError(
				`doctor stdout had a non-JSON line: ${trimmed} (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}
	return { exitCode: exitCode ?? 0, checks, stdout, stderr };
}
