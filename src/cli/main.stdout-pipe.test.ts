import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_AUTH_REJECTED } from "./output.ts";

/**
 * The CLI ran `process.exit(result.exitCode)` right after a command wrote its
 * result. On Linux, Bun writes to a pipe asynchronously, so whatever had not
 * left the process yet was dropped: `warren plan status <id> | jq` received
 * JSON cut off at the 64 KiB pipe buffer. These tests spawn the real entry
 * point with a piped stdout and a response far larger than any pipe buffer.
 * They only fail on Linux; file and console writes are synchronous elsewhere.
 */

const MAIN = join(import.meta.dir, "main.ts");
// Well past the socketpair Bun.spawn hands a child (about 208 KB), so the
// write cannot fit in the pipe buffer by luck.
const PAYLOAD_BYTES = 2 * 1024 * 1024;
const PADDING = "x".repeat(PAYLOAD_BYTES);

let server: ReturnType<typeof Bun.serve>;
let workDir: string;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "warren-stdout-pipe-"));
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/healthz") return Response.json({ ok: true });
			if (path === "/runs/run_big") {
				return Response.json({
					run: {
						id: "run_big",
						agentName: "builder",
						projectId: null,
						state: "succeeded",
						trigger: "manual",
						costUsd: 0,
						failureReason: null,
						prUrl: null,
						seedId: null,
						salvageRef: null,
						salvagePath: null,
						startedAt: null,
						endedAt: null,
						padding: PADDING,
					},
				});
			}
			if (path === "/plan-runs/plnr_big") {
				return Response.json({
					planRun: { id: "plnr_big", state: "succeeded" },
					children: [],
					runs: [],
					padding: PADDING,
				});
			}
			return Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 });
		},
	});
});

afterAll(async () => {
	await server.stop(true);
	await rm(workDir, { recursive: true, force: true });
});

async function runCli(args: readonly string[]) {
	const proc = Bun.spawn({
		cmd: [
			process.execPath,
			MAIN,
			...args,
			"--url",
			`http://127.0.0.1:${server.port}`,
			"--token",
			"test-token",
		],
		// A scratch cwd keeps a developer's .env out of the child.
		cwd: workDir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: workDir,
			WARREN_CLIENT_CONFIG: join(workDir, "client.json"),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("cli output through a pipe", () => {
	test("`show` delivers a run document larger than the pipe buffer intact", async () => {
		const { stdout, stderr, exitCode } = await runCli(["show", "run_big"]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.length).toBeGreaterThan(PAYLOAD_BYTES);
		const parsed = JSON.parse(stdout) as { id: string; padding: string };
		expect(parsed.id).toBe("run_big");
		expect(parsed.padding.length).toBe(PAYLOAD_BYTES);
	});

	test("`plan status` delivers a plan-run document larger than the pipe buffer intact", async () => {
		const { stdout, stderr, exitCode } = await runCli(["plan", "status", "plnr_big"]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.length).toBeGreaterThan(PAYLOAD_BYTES);
		const parsed = JSON.parse(stdout) as { planRun: { id: string }; padding: string };
		expect(parsed.planRun.id).toBe("plnr_big");
		expect(parsed.padding.length).toBe(PAYLOAD_BYTES);
	});

	test("a command that fails still exits with its mapped code", async () => {
		const { stdout, exitCode } = await runCli(["show", "run_denied"]);
		expect(stdout).toBe("");
		expect(exitCode).toBe(EXIT_AUTH_REJECTED);
	});
});
