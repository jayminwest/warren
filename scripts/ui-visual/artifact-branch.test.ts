import { describe, expect, test } from "bun:test";

import {
	ARTIFACT_BRANCH,
	artifactPath,
	keptEntries,
	planCommit,
	publishFiles,
	rawUrl,
} from "./artifact-branch.ts";
import { FakeGhApi } from "./fake-gh-api.ts";

const NOW = new Date("2026-10-08T12:00:00Z");
const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("paths and URLs", () => {
	test("date, PR, and short sha prefix every crop", () => {
		expect(artifactPath(NOW, 12, "abcdef0123456789", "runs.desktop.light")).toBe(
			"2026-10-08/pr-12/abcdef012345/runs.desktop.light.png",
		);
		expect(rawUrl("o/r", "a/b.png")).toBe(
			`https://raw.githubusercontent.com/o/r/${ARTIFACT_BRANCH}/a/b.png`,
		);
	});
});

describe("keptEntries", () => {
	test("keeps dated files inside 30 days and drops everything else", () => {
		const entries = [
			{ path: "2026-10-01/pr-1/a/x.png", sha: "1" },
			{ path: "2026-09-08/pr-1/a/x.png", sha: "2" },
			{ path: "2026-09-07/pr-1/a/x.png", sha: "3" },
			{ path: "README.md", sha: "4" },
		];
		expect(keptEntries(entries, NOW).map((e) => e.sha)).toEqual(["1", "2"]);
	});
});

describe("planCommit", () => {
	test("starts an orphan branch when there is none", () => {
		expect(planCommit(null, NOW)).toMatchObject({ parents: [], epoch: "2026-10-08", force: false });
	});

	test("chains onto a head whose epoch is in the window", () => {
		const head = { sha: "h", message: "ui-visual diff crops (epoch 2026-09-20)" };
		expect(planCommit(head, NOW)).toMatchObject({
			parents: ["h"],
			epoch: "2026-09-20",
			force: false,
		});
	});

	test("cuts the history once the epoch ages out, or is unreadable", () => {
		const old = { sha: "h", message: "ui-visual diff crops (epoch 2026-09-01)" };
		expect(planCommit(old, NOW)).toMatchObject({ parents: [], epoch: "2026-10-08", force: true });
		expect(planCommit({ sha: "h", message: "hand-made" }, NOW)).toMatchObject({ force: true });
	});
});

describe("publishFiles", () => {
	test("creates the branch, then adds files and prunes old ones", async () => {
		const api = new FakeGhApi();
		const urls = await publishFiles(
			api,
			"o/r",
			[{ path: "2026-08-01/pr-1/a/old.png", bytes: bytes("old") }],
			NOW,
		);
		expect(urls).toEqual([rawUrl("o/r", "2026-08-01/pr-1/a/old.png")]);
		expect([...api.files(ARTIFACT_BRANCH).keys()].sort()).toEqual([
			"2026-08-01/pr-1/a/old.png",
			"README.md",
		]);

		await publishFiles(
			api,
			"o/r",
			[{ path: "2026-10-08/pr-2/b/new.png", bytes: bytes("new") }],
			NOW,
		);
		const files = api.files(ARTIFACT_BRANCH);
		expect([...files.keys()].sort()).toEqual(["2026-10-08/pr-2/b/new.png", "README.md"]);
		expect(files.get("2026-10-08/pr-2/b/new.png")).toBe(b64("new"));
	});

	test("retries when another writer moves the branch first, keeping both files", async () => {
		const api = new FakeGhApi();
		await publishFiles(api, "o/r", [{ path: "2026-10-08/pr-1/a/one.png", bytes: bytes("1") }], NOW);
		api.beforeRefUpdate = () => {
			// A concurrent writer lands three.png between our read and our ref update.
			api.beforeRefUpdate = null;
			const head = api.refs.get(ARTIFACT_BRANCH) ?? "";
			const tree = api.trees.get(api.commits.get(head)?.tree ?? "") ?? [];
			api.blobs.set("b3", b64("3"));
			api.trees.set("t3", [...tree, { path: "2026-10-08/pr-3/c/three.png", sha: "b3" }]);
			api.commits.set("c3", {
				message: "ui-visual diff crops (epoch 2026-10-08)",
				tree: "t3",
				parents: [head],
			});
			api.refs.set(ARTIFACT_BRANCH, "c3");
		};
		await publishFiles(api, "o/r", [{ path: "2026-10-08/pr-2/b/two.png", bytes: bytes("2") }], NOW);
		expect(api.calls.filter((c) => c.startsWith("PATCH")).length).toBe(2);
		expect(api.commits.get(api.refs.get(ARTIFACT_BRANCH) ?? "")?.parents).toEqual(["c3"]);
		expect([...api.files(ARTIFACT_BRANCH).keys()].sort()).toEqual([
			"2026-10-08/pr-1/a/one.png",
			"2026-10-08/pr-2/b/two.png",
			"2026-10-08/pr-3/c/three.png",
			"README.md",
		]);
	});
});
