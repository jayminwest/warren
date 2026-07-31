import { describe, expect, test } from "bun:test";
import { MAX_SALVAGE_BUNDLE_BYTES, rescueBranchFor } from "../salvage.ts";
import type { FinalizeGitRunner } from "./finalize-collect.ts";
import {
	buildSalvageBundle,
	type CollectSalvageDeps,
	collectSalvage,
	pushRescueRef,
} from "./salvage.ts";

/** Git seam recording argv, returning scripted results by first arg. */
function fakeGit(
	script: Partial<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): { git: FinalizeGitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: FinalizeGitRunner = async (args) => {
		calls.push(args);
		const key = args[0] === "remote" ? `remote ${args[1]}` : (args[0] ?? "");
		const s = script[key] ?? {};
		return { exitCode: s.exitCode ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
	};
	return { git, calls };
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

describe("collectSalvage", () => {
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
		expect(calls.find((c) => c[0] === "push")).toBeUndefined();
	});

	test("rescueBranchFor names the recovery branch operators fetch", () => {
		expect(rescueBranchFor("run_abc")).toBe("warren/rescue/run_abc");
	});
});
