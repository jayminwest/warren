/**
 * Process-level regression test for the entrypoint (src/cli/main.ts).
 *
 * Every other CLI test drives `runCli` with an injected `env`, which is
 * how the entrypoint shipped without wiring `process.env` at all — the
 * container contract (env-only configuration and secrets) was dead on
 * arrival in any real deployment. This spawns the real entrypoint and
 * proves the named environment variables reach configuration resolution.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

async function spawnCli(
	args: string[],
	env: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		env: { ...env, PATH: process.env.PATH ?? "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const code = await proc.exited;
	return { code, stdout };
}

describe("main entrypoint", () => {
	test("CAMPAIGN_DB_PATH from the process environment reaches the CLI", async () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "cc-main-")), "campaign.db");
		const { code, stdout } = await spawnCli(["status"], { CAMPAIGN_DB_PATH: dbPath });
		expect(code).toBe(0);
		const envelope = JSON.parse(stdout.trim().split("\n")[0] ?? "{}");
		expect(envelope.ok).toBe(true);
	});

	test("without the environment the same command fails on config (exit 3)", async () => {
		const { code, stdout } = await spawnCli(["status"], {});
		expect(code).toBe(3);
		expect(stdout).toContain("CAMPAIGN_DB_PATH");
	});
});
