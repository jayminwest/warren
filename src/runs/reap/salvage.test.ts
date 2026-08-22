import { describe, expect, test } from "bun:test";
import { salvageWorkspace } from "./salvage.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/** Exec seam recording calls; pushes/bundles succeed unless scripted to fail. */
function fakeExec(opts: { failPush?: boolean; failBundle?: boolean } = {}): {
	exec: ReapExec;
	calls: { args: readonly string[] }[];
} {
	const calls: { args: readonly string[] }[] = [];
	return {
		calls,
		exec: {
			run: async (_cmd, args) => {
				calls.push({ args });
				if (opts.failPush === true && args[0] === "push") throw new Error("push declined");
				if (opts.failBundle === true && args[0] === "bundle") throw new Error("empty bundle");
				return { stdout: "", stderr: "" };
			},
		},
	};
}

const fs: ReapFs = {
	mkdirp: async () => {},
	readFile: async () => null,
	writeFile: async () => {},
	readdir: async () => [],
};

const input = {
	runId: "run_x",
	workspacePath: "/ws",
	baseBranch: "main" as string | null,
	salvageDir: "/data/salvage",
	fs,
};

describe("salvageWorkspace (warren-cd3b)", () => {
	test("the rescue-ref push is attempted first and reports the branch", async () => {
		const { exec, calls } = fakeExec();
		const out = await salvageWorkspace({ ...input, exec });
		expect(out.rescueRef).toBe("warren/rescue/run_x");
		expect(out.bundlePath).toBeNull();
		expect(out.errors).toEqual([]);
		expect(calls[0]?.args).toEqual(["push", "origin", "HEAD:refs/heads/warren/rescue/run_x"]);
		// A landed rescue push makes the bundle capture unnecessary.
		expect(calls.find((c) => c.args[0] === "bundle")).toBeUndefined();
	});

	test("the rescue push carries the minted credential as GIT_CONFIG_* env (warren-4e1c)", async () => {
		const envs: (Record<string, string | undefined> | undefined)[] = [];
		const exec: ReapExec = {
			run: async (_cmd, _args, opts) => {
				envs.push(opts.env);
				return { stdout: "", stderr: "" };
			},
		};
		const out = await salvageWorkspace({
			...input,
			exec,
			gitCredential: { username: "x-access-token", secret: "ghp_rescue", host: "github.com" },
		});
		expect(out.rescueRef).toBe("warren/rescue/run_x");
		expect(envs[0]?.GIT_CONFIG_COUNT).toBe("1");
		expect(envs[0]?.GIT_CONFIG_KEY_0).toBe(
			"url.https://x-access-token:ghp_rescue@github.com/.insteadOf",
		);
		expect(envs[0]?.GIT_CONFIG_VALUE_0).toBe("https://github.com/");
	});

	test("no gitToken keeps the rescue push anonymous (empty env overrides)", async () => {
		const envs: (Record<string, string | undefined> | undefined)[] = [];
		const exec: ReapExec = {
			run: async (_cmd, _args, opts) => {
				envs.push(opts.env);
				return { stdout: "", stderr: "" };
			},
		};
		const out = await salvageWorkspace({ ...input, exec });
		expect(out.rescueRef).toBe("warren/rescue/run_x");
		expect(envs[0]).toEqual({});
	});

	test("a rejected rescue push falls through to the durable bundle", async () => {
		const { exec, calls } = fakeExec({ failPush: true });
		const out = await salvageWorkspace({ ...input, exec });
		expect(out.rescueRef).toBeNull();
		expect(out.bundlePath).toBe("/data/salvage/run_x.bundle");
		const bundle = calls.find((c) => c.args[0] === "bundle");
		expect(bundle?.args).toEqual(["bundle", "create", "/data/salvage/run_x.bundle", "main..HEAD"]);
		expect(out.errors[0]).toContain("rescue push");
	});

	test("an unknown base bundles the full HEAD history", async () => {
		const { exec, calls } = fakeExec({ failPush: true });
		await salvageWorkspace({ ...input, baseBranch: null, exec });
		expect(calls.find((c) => c.args[0] === "bundle")?.args[3]).toBe("HEAD");
	});

	test("a failed push with no salvageDir leaves nothing (but notes why)", async () => {
		const { exec } = fakeExec({ failPush: true });
		const { salvageDir: _drop, ...rest } = input;
		const out = await salvageWorkspace({ ...rest, exec });
		expect(out.rescueRef).toBeNull();
		expect(out.bundlePath).toBeNull();
		expect(out.errors).toHaveLength(1);
	});

	test("when every capture fails the outcome is explicitly empty", async () => {
		const { exec } = fakeExec({ failPush: true, failBundle: true });
		const out = await salvageWorkspace({ ...input, exec });
		expect(out.rescueRef).toBeNull();
		expect(out.bundlePath).toBeNull();
		expect(out.errors).toHaveLength(2);
	});
});
