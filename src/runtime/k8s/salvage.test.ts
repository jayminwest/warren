import { describe, expect, test } from "bun:test";
import { WARREN_BOT_IDENTITY } from "../../bot-identity.ts";
import { MAX_SALVAGE_BUNDLE_BYTES, rescueBranchFor } from "../salvage.ts";
import type { FinalizeGitRunner } from "./finalize-collect.ts";
import {
	buildSalvageBundle,
	type CollectSalvageDeps,
	collectSalvage,
	commitUncommittedWork,
	pushRescueRef,
} from "./salvage.ts";

/** The git verb of an argv, skipping `-c <k=v>` config prefixes (warren-6016 commits). */
function verbOf(args: string[]): string {
	for (let i = 0; i < args.length; i += 1) {
		const a = args[i];
		if (a === "-c") {
			i += 1;
			continue;
		}
		return a ?? "";
	}
	return "";
}

/** Git seam recording argv + env opts, returning scripted results by verb. */
function fakeGit(
	script: Partial<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): {
	git: FinalizeGitRunner;
	calls: string[][];
	envs: (Record<string, string | undefined> | undefined)[];
} {
	const calls: string[][] = [];
	const envs: (Record<string, string | undefined> | undefined)[] = [];
	const git: FinalizeGitRunner = async (args, opts) => {
		calls.push(args);
		envs.push(opts?.env);
		const verb = verbOf(args);
		const key = verb === "remote" ? `remote ${args[1]}` : verb;
		const s = script[key] ?? {};
		return { exitCode: s.exitCode ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
	};
	return { git, calls, envs };
}

function deps(over: Partial<CollectSalvageDeps> = {}): CollectSalvageDeps {
	return {
		git: fakeGit().git,
		readFileBytes: async () => new TextEncoder().encode("bundle-bytes"),
		rm: async () => {},
		...over,
	};
}

const input = {
	runId: "run_x",
	workspacePath: "/ws",
	baseBranch: "main" as string | undefined,
	gitToken: "tok" as string | undefined,
};

describe("pushRescueRef", () => {
	test("pushes HEAD to the per-run rescue branch over the authenticated origin", async () => {
		const { git, calls } = fakeGit({
			"remote get-url": { stdout: "https://github.com/acme/widgets.git" },
		});
		const notes: string[] = [];
		const ref = await pushRescueRef(input, git, notes);
		expect(ref).toBe("warren/rescue/run_x");
		const push = calls.find((c) => c[0] === "push");
		expect(push).toEqual(["push", "origin", "HEAD:refs/heads/warren/rescue/run_x"]);
		// Origin was re-authenticated for the push and restored after.
		const setUrls = calls.filter((c) => c[0] === "remote" && c[1] === "set-url");
		expect(setUrls).toHaveLength(2);
		expect(setUrls[0]?.[3]).toContain("tok");
		expect(setUrls[1]?.[3]).toBe("https://github.com/acme/widgets.git");
		expect(notes).toHaveLength(0);
	});

	test("a rejected rescue push degrades to null + a note (push protection scans the same history)", async () => {
		const { git } = fakeGit({
			push: { exitCode: 1, stderr: "remote: push declined due to repository rule violations" },
		});
		const notes: string[] = [];
		const ref = await pushRescueRef(input, git, notes);
		expect(ref).toBeNull();
		expect(notes[0]).toContain("warren/rescue/run_x");
	});

	test("no credential ⇒ the push is skipped with a note (the no_intent window)", async () => {
		const { git, calls } = fakeGit();
		const notes: string[] = [];
		const ref = await pushRescueRef({ ...input, gitToken: undefined }, git, notes);
		expect(ref).toBeNull();
		expect(calls.find((c) => c[0] === "push")).toBeUndefined();
		expect(notes[0]).toContain("no git credential");
	});
});

describe("buildSalvageBundle", () => {
	test("bundles <base>..HEAD and returns it base64-encoded", async () => {
		const { git, calls } = fakeGit();
		const notes: string[] = [];
		const b64 = await buildSalvageBundle(input, deps({ git }), notes);
		const create = calls.find((c) => c[0] === "bundle");
		expect(create?.[1]).toBe("create");
		expect(create?.[3]).toBe("main..HEAD");
		expect(b64).toBe(Buffer.from("bundle-bytes").toString("base64"));
		expect(notes).toHaveLength(0);
	});

	test("an unknown base bundles the full HEAD history", async () => {
		const { git, calls } = fakeGit();
		await buildSalvageBundle({ ...input, baseBranch: undefined }, deps({ git }), []);
		expect(calls.find((c) => c[0] === "bundle")?.[3]).toBe("HEAD");
	});

	test("an empty range (nothing committed ahead) degrades to null + a note", async () => {
		const { git } = fakeGit({
			bundle: { exitCode: 1, stderr: "Refusing to create empty bundle." },
		});
		const notes: string[] = [];
		const b64 = await buildSalvageBundle(input, deps({ git }), notes);
		expect(b64).toBeNull();
		expect(notes[0]).toContain("empty bundle");
	});

	test("an over-cap bundle is dropped with a note rather than posted", async () => {
		const { git } = fakeGit();
		const notes: string[] = [];
		const b64 = await buildSalvageBundle(
			input,
			deps({ git, readFileBytes: async () => new Uint8Array(MAX_SALVAGE_BUNDLE_BYTES + 1) }),
			notes,
		);
		expect(b64).toBeNull();
		expect(notes[0]).toContain("over the");
	});
});

describe("commitUncommittedWork (warren-6016)", () => {
	test("a dirty tree is staged and committed with the canonical bot identity before any capture", async () => {
		const { git, calls, envs } = fakeGit({ status: { stdout: " M src/dirty.ts\n" } });
		const notes: string[] = [];
		await commitUncommittedWork(input, git, notes);
		const verbs = calls.map((c) => verbOf(c));
		expect(verbs).toEqual(["status", "add", "commit"]);
		expect(calls[1]).toEqual(["add", "-A"]);
		const commit = calls[2] ?? [];
		// The identity comes from the bot-identity resolver (Article VII), never
		// re-spelled inline, and the commit never gates on project hooks.
		expect(commit).toContain(`user.name=${WARREN_BOT_IDENTITY.name}`);
		expect(commit).toContain(`user.email=${WARREN_BOT_IDENTITY.email}`);
		expect(commit).toContain("--no-verify");
		expect(commit[commit.length - 1]).toContain("chore(warren): salvage uncommitted");
		expect(commit[commit.length - 1]).toContain("run_x");
		// The commit spawn pins the identity env AND scrubs the inherited repo context.
		const commitEnv = envs[2] ?? {};
		expect(commitEnv.GIT_AUTHOR_NAME).toBe(WARREN_BOT_IDENTITY.name);
		expect(commitEnv.GIT_COMMITTER_EMAIL).toBe(WARREN_BOT_IDENTITY.email);
		expect(commitEnv.GIT_DIR).toBeUndefined();
		expect("GIT_DIR" in commitEnv).toBe(true); // scrubbed, not merely absent
		expect(notes[0]).toContain("bookkeeping commit");
	});

	test("a clean tree skips staging + the commit entirely", async () => {
		const { git, calls } = fakeGit({ status: { stdout: "" } });
		const notes: string[] = [];
		await commitUncommittedWork(input, git, notes);
		expect(calls.map((c) => verbOf(c))).toEqual(["status"]);
		expect(notes).toHaveLength(0);
	});

	test("a failed probe or commit degrades to a note, never a throw", async () => {
		const probeFail = fakeGit({ status: { exitCode: 128, stderr: "not a git repository" } });
		const notes1: string[] = [];
		await commitUncommittedWork(input, probeFail.git, notes1);
		expect(notes1[0]).toContain("dirty-tree probe failed");
		expect(probeFail.calls.map((c) => verbOf(c))).toEqual(["status"]);

		const commitFail = fakeGit({
			status: { stdout: "?? new.ts\n" },
			commit: { exitCode: 1, stderr: "hook declined" },
		});
		const notes2: string[] = [];
		await commitUncommittedWork(input, commitFail.git, notes2);
		expect(notes2[0]).toContain("dirty-tree salvage commit failed");
	});

	test("the operator identity override (WARREN_BOT_NAME/EMAIL) is honored by the resolver", async () => {
		const prev = { name: process.env.WARREN_BOT_NAME, email: process.env.WARREN_BOT_EMAIL };
		process.env.WARREN_BOT_NAME = "acme-warren-bot";
		process.env.WARREN_BOT_EMAIL = "bot@acme.example";
		try {
			const { git, calls } = fakeGit({ status: { stdout: " M a.ts\n" } });
			await commitUncommittedWork(input, git, []);
			const commit = calls.find((c) => verbOf(c) === "commit") ?? [];
			expect(commit).toContain("user.name=acme-warren-bot");
			expect(commit).toContain("user.email=bot@acme.example");
		} finally {
			if (prev.name === undefined) delete process.env.WARREN_BOT_NAME;
			else process.env.WARREN_BOT_NAME = prev.name;
			if (prev.email === undefined) delete process.env.WARREN_BOT_EMAIL;
			else process.env.WARREN_BOT_EMAIL = prev.email;
		}
	});
});

describe("collectSalvage", () => {
	test("a dirty tree is committed BEFORE the rescue push and the bundle (warren-6016)", async () => {
		const { git, calls } = fakeGit({
			status: { stdout: " M uncommitted.ts\n" },
			"remote get-url": { stdout: "https://github.com/acme/widgets.git" },
		});
		const out = await collectSalvage(input, deps({ git }));
		const verbs = calls.map((c) => verbOf(c));
		// commit (status/add/commit) precedes push, which precedes bundle.
		expect(verbs.indexOf("commit")).toBeLessThan(verbs.indexOf("push"));
		expect(verbs.indexOf("push")).toBeLessThan(verbs.indexOf("bundle"));
		expect(out.rescueRef).toBe("warren/rescue/run_x");
		expect(out.bundleBase64).not.toBeNull();
		expect(out.notes.some((n) => n.includes("bookkeeping commit"))).toBe(true);
	});

	test("a thrown dirty-tree step never masks the captures", async () => {
		const base = fakeGit();
		const git: FinalizeGitRunner = async (args, opts) => {
			if (verbOf(args) === "status") throw new Error("spawn exploded");
			return base.git(args, opts);
		};
		const out = await collectSalvage(input, deps({ git }));
		expect(out.rescueRef).toBe("warren/rescue/run_x");
		expect(out.bundleBase64).not.toBeNull();
		expect(out.notes.some((n) => n.includes("dirty-tree salvage commit errored"))).toBe(true);
	});

	test("a failing push still yields the bundle (the push-protection scenario)", async () => {
		const { git } = fakeGit({ push: { exitCode: 1, stderr: "declined" } });
		const out = await collectSalvage(input, deps({ git }));
		expect(out.rescueRef).toBeNull();
		expect(out.bundleBase64).toBe(Buffer.from("bundle-bytes").toString("base64"));
		expect(out.notes.some((n) => n.includes("rescue push"))).toBe(true);
	});

	test("the no_intent window (no token) captures the bundle only", async () => {
		const { git, calls } = fakeGit();
		const out = await collectSalvage({ ...input, gitToken: undefined }, deps({ git }));
		expect(out.rescueRef).toBeNull();
		expect(out.bundleBase64).not.toBeNull();
		expect(calls.find((c) => verbOf(c) === "push")).toBeUndefined();
	});

	test("rescueBranchFor names the recovery branch operators fetch", () => {
		expect(rescueBranchFor("run_abc")).toBe("warren/rescue/run_abc");
	});
});
