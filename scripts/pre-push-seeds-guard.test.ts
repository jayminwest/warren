import { describe, expect, test } from "bun:test";
import {
	buildDiffRange,
	isSeedsJsonlPath,
	listChangedPaths,
	type PushRef,
	parsePushLine,
	seedsTouched,
} from "./pre-push-seeds-guard.ts";

const ZERO = "0000000000000000000000000000000000000000";
const LOCAL = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ref(over: Partial<PushRef> = {}): PushRef {
	return {
		localRef: "refs/heads/main",
		localOid: LOCAL,
		remoteRef: "refs/heads/main",
		remoteOid: REMOTE,
		...over,
	};
}

describe("parsePushLine", () => {
	test("parses a standard four-field pre-push line", () => {
		expect(parsePushLine(`refs/heads/main ${LOCAL} refs/heads/main ${REMOTE}`)).toEqual({
			localRef: "refs/heads/main",
			localOid: LOCAL,
			remoteRef: "refs/heads/main",
			remoteOid: REMOTE,
		});
	});

	test("tolerates extra whitespace", () => {
		expect(parsePushLine(`  refs/heads/f ${LOCAL}   refs/heads/f  ${ZERO}  `)?.remoteOid).toBe(
			ZERO,
		);
	});

	test("returns null for blank and malformed lines", () => {
		expect(parsePushLine("")).toBeNull();
		expect(parsePushLine("   ")).toBeNull();
		expect(parsePushLine("refs/heads/main only-two")).toBeNull();
	});
});

describe("buildDiffRange", () => {
	test("returns remote..local for an update to an existing branch", () => {
		expect(buildDiffRange(ref())).toBe(`${REMOTE}..${LOCAL}`);
	});

	test("returns just the local tip for a new branch", () => {
		expect(buildDiffRange(ref({ remoteOid: ZERO }))).toBe(LOCAL);
	});

	test("returns null for a branch delete", () => {
		expect(buildDiffRange(ref({ localOid: ZERO }))).toBeNull();
	});
});

describe("isSeedsJsonlPath / seedsTouched", () => {
	test("matches top-level .seeds/*.jsonl only", () => {
		expect(isSeedsJsonlPath(".seeds/issues.jsonl")).toBe(true);
		expect(isSeedsJsonlPath(".seeds/plans.jsonl")).toBe(true);
		expect(isSeedsJsonlPath(".seeds/templates.jsonl")).toBe(true);
		expect(isSeedsJsonlPath(".seeds/nested/x.jsonl")).toBe(false);
		expect(isSeedsJsonlPath(".mulch/expertise/foo.jsonl")).toBe(false);
		expect(isSeedsJsonlPath("src/foo.ts")).toBe(false);
		expect(isSeedsJsonlPath(".seeds/config.yaml")).toBe(false);
	});

	test("seedsTouched is true when any path matches", () => {
		expect(seedsTouched(["src/a.ts", "README.md"])).toBe(false);
		expect(seedsTouched(["src/a.ts", ".seeds/issues.jsonl"])).toBe(true);
		expect(seedsTouched([])).toBe(false);
	});
});

describe("listChangedPaths", () => {
	test("returns empty for a branch delete without calling git", () => {
		let called = false;
		const paths = listChangedPaths(ref({ localOid: ZERO }), () => {
			called = true;
			return { ok: true, stdout: "", stderr: "" };
		});
		expect(paths).toEqual([]);
		expect(called).toBe(false);
	});

	test("diffs remote..local for an existing-branch update", () => {
		const seen: string[][] = [];
		const paths = listChangedPaths(ref(), (args) => {
			seen.push([...args]);
			return { ok: true, stdout: "src/a.ts\n.seeds/issues.jsonl\n", stderr: "" };
		});
		expect(seen).toEqual([["diff", "--name-only", `${REMOTE}..${LOCAL}`]]);
		expect(paths).toEqual(["src/a.ts", ".seeds/issues.jsonl"]);
	});

	test("diffs the tip against the empty tree for a new branch", () => {
		const seen: string[][] = [];
		listChangedPaths(ref({ remoteOid: ZERO }), (args) => {
			seen.push([...args]);
			return { ok: true, stdout: ".seeds/plans.jsonl\n", stderr: "" };
		});
		expect(seen).toHaveLength(1);
		const args = seen[0] ?? [];
		expect(args[0]).toBe("diff-tree");
		expect(args).toContain(LOCAL);
		expect(args).toContain("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
	});

	test("returns empty when git fails", () => {
		expect(listChangedPaths(ref(), () => ({ ok: false, stdout: "", stderr: "boom" }))).toEqual([]);
	});
});
