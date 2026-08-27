import { describe, expect, test } from "bun:test";
import type { WarrenClientConfig } from "../../client/index.ts";
import type { WarrenServerHandle } from "../../server/main/index.ts";
import type { CliContext } from "../output.ts";
import {
	defaultUpDataDir,
	detectUpRuntime,
	runUp,
	type UpDeps,
	type UpRuntimeProbe,
} from "./up.ts";
import type { UpWizardDeps } from "./up-wizard.ts";

function probe(over: Partial<UpRuntimeProbe>): UpRuntimeProbe {
	return {
		platform: "linux",
		hasBinary: () => false,
		dockerDaemonReachable: () => false,
		...over,
	};
}

describe("detectUpRuntime", () => {
	test("picks the local provider on darwin when sandbox-exec is present", () => {
		const d = detectUpRuntime({}, probe({ platform: "darwin", hasBinary: () => true }));
		expect(d).toEqual({
			choice: "boot",
			runtime: "local",
			sentence: "runtime: local (darwin sandbox-exec)",
		});
	});

	test("picks the local provider on linux when bwrap is on PATH", () => {
		const d = detectUpRuntime(
			{},
			probe({
				platform: "linux",
				hasBinary: (name) => name === "bwrap",
			}),
		);
		expect(d.choice).toBe("boot");
		if (d.choice === "boot") expect(d.runtime).toBe("local");
	});

	test("never overrides an explicit WARREN_RUNTIME", () => {
		const d = detectUpRuntime({ WARREN_RUNTIME: "k8s" }, probe({ platform: "linux" }));
		expect(d).toMatchObject({ choice: "boot", runtime: "k8s" });
	});

	test("falls to docker guidance when no native sandbox but a daemon answers", () => {
		const d = detectUpRuntime({}, probe({ dockerDaemonReachable: () => true }));
		expect(d.choice).toBe("docker-guidance");
	});

	test("fails naming the missing sandbox when nothing is usable", () => {
		const d = detectUpRuntime({}, probe({}));
		expect(d.choice).toBe("fail");
		if (d.choice === "fail") expect(d.message).toContain("bwrap");
	});

	test("falls to docker guidance on darwin without sandbox-exec", () => {
		const d = detectUpRuntime({}, probe({ platform: "darwin", dockerDaemonReachable: () => true }));
		expect(d.choice).toBe("docker-guidance");
	});
});

function captureContext(env: Record<string, string> = {}): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env,
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

function bootedHandle(token?: string, setupUrl?: string): WarrenServerHandle {
	return {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 8080 },
		url: "http://127.0.0.1:8080",
		...(token !== undefined ? { operatorToken: token } : {}),
		...(setupUrl !== undefined ? { setupUrl } : {}),
		stop: async () => undefined,
	};
}

function wizardDeps(over: Partial<UpWizardDeps> = {}): UpWizardDeps {
	return {
		homeDir: () => "/home/op",
		isInteractive: () => false,
		prompt: async () => {
			throw new Error("prompt must not run in this test");
		},
		runCommand: async () => ({ stdout: "", exitCode: 1 }),
		hasBinary: () => false,
		fetchGitHubLogin: async () => undefined,
		...over,
	};
}

function happyDeps(over: Partial<UpDeps> = {}): UpDeps {
	return {
		probe: probe({ platform: "linux", hasBinary: (n) => n === "bwrap" }),
		homeDir: () => "/home/op",
		mkdir: () => undefined,
		saveConfig: () => "/home/op/.warren/client.json",
		wizard: wizardDeps(),
		serveDeps: {
			boot: async () => bootedHandle("tok123"),
			waitForShutdown: async () => undefined,
		},
		...over,
	};
}

describe("runUp", () => {
	test("prints the runtime choice, defaults the data dir, and logs the operator in", async () => {
		const { context, out, err } = captureContext();
		const saved: WarrenClientConfig[] = [];
		const envs: unknown[] = [];
		let booted = false;

		const result = await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async () => {
						booted = true;
						return bootedHandle("tok123");
					},
					waitForShutdown: async () => {
						expect(booted).toBe(true);
					},
				},
				saveConfig: (config, env) => {
					saved.push(config);
					envs.push(env);
					return "/home/op/.warren/client.json";
				},
			}),
			{},
		);

		expect(result.exitCode).toBe(0);
		expect(result.url).toBe("http://127.0.0.1:8080");
		expect(out.join("")).toContain("runtime: local (linux bwrap)");
		expect(out.join("")).toContain("✔ logged in to http://127.0.0.1:8080");
		expect(saved).toEqual([{ baseUrl: "http://127.0.0.1:8080", token: "tok123" }]);
		// The patched env carries both defaults into the boot.
		const env = envs[0] as Record<string, string | undefined>;
		expect(env.WARREN_DATA_DIR).toBe("/home/op/.warren/data");
		expect(env.WARREN_RUNTIME).toBe("local");
		expect(err).toEqual([]);
	});

	test("creates the default data dir 0700 and leaves an explicit WARREN_DATA_DIR alone", async () => {
		const { context } = captureContext({ WARREN_DATA_DIR: "/data" });
		const made: string[] = [];
		let seenEnv: Record<string, string | undefined> | undefined;
		await runUp(
			context,
			happyDeps({
				mkdir: (p) => made.push(p),
				saveConfig: (_c, env) => {
					seenEnv = env as Record<string, string | undefined>;
					return "/home/op/.warren/client.json";
				},
			}),
			{},
		);
		expect(made).toEqual([]);
		expect(seenEnv?.WARREN_DATA_DIR).toBe("/data");
	});

	test("exits 0 with compose guidance when only docker is available", async () => {
		const { context, out } = captureContext();
		const result = await runUp(
			context,
			happyDeps({ probe: probe({ dockerDaemonReachable: () => true }) }),
			{},
		);
		expect(result.exitCode).toBe(0);
		expect(out.join("")).toContain("docker compose up -d");
	});

	test("exits non-zero naming the missing sandbox when nothing is usable", async () => {
		const { context, err } = captureContext();
		const result = await runUp(context, happyDeps({ probe: probe({}) }), {});
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("bwrap");
	});

	test("skips the client-config write when the boot carried no minted token", async () => {
		const { context, out } = captureContext();
		let saved = false;
		await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async () => bootedHandle(),
					waitForShutdown: async () => undefined,
				},
				saveConfig: () => {
					saved = true;
					return "/home/op/.warren/client.json";
				},
			}),
			{},
		);
		expect(saved).toBe(false);
		expect(out.join("")).not.toContain("logged in");
	});

	test("fails the command when the data dir cannot be created", async () => {
		const { context, err } = captureContext();
		const result = await runUp(
			context,
			happyDeps({
				mkdir: () => {
					throw new Error("EACCES");
				},
			}),
			{},
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("EACCES");
	});

	test("still prints the plain UI URL under --no-open when no handoff armed (no credential rides it)", async () => {
		const { context, out } = captureContext();
		await runUp(context, happyDeps(), { open: false });
		expect(out.join("")).toContain("UI: http://127.0.0.1:8080");
	});

	test("opens the browser at the one-time setup URL on a TTY (warren-48f8)", async () => {
		const { context, out } = captureContext();
		const opened: string[] = [];
		let bootedWithHandoff = false;
		await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async (opts) => {
						bootedWithHandoff = opts?.setupHandoff === true;
						return bootedHandle("tok123", "http://127.0.0.1:8080/setup?code=c1");
					},
					waitForShutdown: async () => undefined,
				},
				isTty: () => true,
				openBrowser: (url) => opened.push(url),
			}),
			{},
		);
		expect(bootedWithHandoff).toBe(true);
		expect(opened).toEqual(["http://127.0.0.1:8080/setup?code=c1"]);
		expect(out.join("")).toContain("UI: http://127.0.0.1:8080/setup?code=c1");
	});

	test("prints the setup URL without opening a browser when stdout is not a TTY", async () => {
		const { context, out } = captureContext();
		const opened: string[] = [];
		await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async () => bootedHandle("tok123", "http://127.0.0.1:8080/setup?code=c1"),
					waitForShutdown: async () => undefined,
				},
				isTty: () => false,
				openBrowser: (url) => opened.push(url),
			}),
			{},
		);
		expect(opened).toEqual([]);
		expect(out.join("")).toContain("UI: http://127.0.0.1:8080/setup?code=c1");
	});

	test("--no-open keeps the redemption URL visible as the fallback", async () => {
		const { context, out } = captureContext();
		const opened: string[] = [];
		await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async () => bootedHandle("tok123", "http://127.0.0.1:8080/setup?code=c1"),
					waitForShutdown: async () => undefined,
				},
				isTty: () => true,
				openBrowser: (url) => opened.push(url),
			}),
			{ open: false },
		);
		expect(opened).toEqual([]);
		expect(out.join("")).toContain("http://127.0.0.1:8080/setup?code=c1");
	});

	test("falls back to the plain UI URL when the boot armed no handoff", async () => {
		const { context, out } = captureContext();
		let bootedWithHandoff = true;
		await runUp(
			context,
			happyDeps({
				serveDeps: {
					boot: async (opts) => {
						bootedWithHandoff = opts?.setupHandoff === true;
						return bootedHandle("tok123");
					},
					waitForShutdown: async () => undefined,
				},
				isTty: () => true,
			}),
			{},
		);
		expect(bootedWithHandoff).toBe(true);
		expect(out.join("")).toContain("UI: http://127.0.0.1:8080\n");
	});
});

describe("defaultUpDataDir", () => {
	test("defaults to ~/.warren/data under the given home", () => {
		expect(defaultUpDataDir("/home/op")).toBe("/home/op/.warren/data");
	});
});
