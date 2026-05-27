import { describe, expect, test } from "bun:test";
import type { WarrenServerHandle } from "../../server/main/index.ts";
import type { CliContext } from "../output.ts";
import { runServe } from "./serve.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: { WARREN_API_TOKEN: "tok" },
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	return { context, out, err };
}

describe("runServe", () => {
	test("boots, prints the URL, waits for shutdown, then stops cleanly", async () => {
		const { context, out, err } = captureContext();
		let stopped = false;

		const handle: WarrenServerHandle = {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 8080 },
			url: "http://127.0.0.1:8080",
			stop: async () => {
				stopped = true;
			},
		};

		const result = await runServe(
			context,
			{
				boot: async () => handle,
				waitForShutdown: async () => undefined,
			},
			{},
		);

		expect(result.exitCode).toBe(0);
		expect(result.url).toBe("http://127.0.0.1:8080");
		expect(out.join("")).toContain("warren listening at http://127.0.0.1:8080");
		expect(err).toEqual([]);
		expect(stopped).toBe(true);
	});

	test("surfaces a boot failure as exit 1 without calling waitForShutdown", async () => {
		const { context, err } = captureContext();
		let waited = false;

		const result = await runServe(
			context,
			{
				boot: async () => {
					throw new Error("boom");
				},
				waitForShutdown: async () => {
					waited = true;
				},
			},
			{},
		);

		expect(result.exitCode).toBe(1);
		expect(waited).toBe(false);
		expect(err.join("")).toContain("boom");
	});

	test("forwards the --no-auth flag through to bootServer", async () => {
		const { context } = captureContext();
		let received: { noAuth?: boolean } | undefined;
		const handle: WarrenServerHandle = {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			url: "http://127.0.0.1:0",
			stop: async () => undefined,
		};
		await runServe(
			context,
			{
				boot: async (opts) => {
					received = opts;
					return handle;
				},
				waitForShutdown: async () => undefined,
			},
			{ noAuth: true },
		);
		expect(received?.noAuth).toBe(true);
	});
});
