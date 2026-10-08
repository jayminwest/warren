import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ARTIFACT_BRANCH } from "./artifact-branch.ts";
import { UI_VISUAL_MARKER } from "./diff-comment.ts";
import { FakeGhApi } from "./fake-gh-api.ts";
import { createImage, decodePng, encodePng } from "./png.ts";
import { readFailures, runCommentJob, UI_VISUAL_WORKFLOW_PATH } from "./pr-comment.ts";

const SHA = "a".repeat(40);
const NOW = new Date("2026-10-08T12:00:00Z");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `ui-screenshots-<sha>` artifact with the given failing cases. */
function artifact(pr: unknown, cases: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "ui-visual-comment-test-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "ci-meta.json"),
		JSON.stringify({ pr, headSha: SHA, outcome: "failure" }),
	);
	for (const name of cases) {
		const [page, viewport, theme] = name.split(".");
		const caseDir = join(dir, "golden-diff", name);
		mkdirSync(caseDir, { recursive: true });
		const expected = createImage(100, 50, [255, 255, 255, 255]);
		const diff = createImage(100, 50, [230, 230, 230, 255]);
		for (let x = 10; x < 20; x++) diff.data.set([255, 0, 0, 255], (25 * 100 + x) * 4);
		writeFileSync(join(caseDir, "expected.png"), encodePng(expected));
		writeFileSync(join(caseDir, "actual.png"), encodePng(expected));
		writeFileSync(join(caseDir, "diff.png"), encodePng(diff));
		writeFileSync(
			join(caseDir, "result.json"),
			JSON.stringify({
				case: name,
				page,
				viewport,
				theme,
				images: ["actual.png", "diff.png", "expected.png"],
				error: "10 pixels (ratio 0.01 of all image pixels) are different.",
			}),
		);
	}
	return dir;
}

function setup(conclusion: string, dir: string | null) {
	const api = new FakeGhApi();
	api.runs.set("99", {
		path: UI_VISUAL_WORKFLOW_PATH,
		status: "completed",
		conclusion,
		head_sha: SHA,
		html_url: "https://example.test/runs/99",
	});
	api.pulls.set(5, { state: "open", head: { sha: SHA } });
	const log: string[] = [];
	const deps = {
		api,
		repo: "o/r",
		runId: "99",
		download: (name: string) => Promise.resolve(name === `ui-screenshots-${SHA}` ? dir : null),
		now: NOW,
		log: (line: string) => log.push(line),
	};
	return { api, deps, log };
}

describe("readFailures", () => {
	test("reads valid results and skips a directory whose name disagrees", () => {
		const dir = artifact(5, ["runs.desktop.light", "agents.phone.light"]);
		mkdirSync(join(dir, "golden-diff", "evil"), { recursive: true });
		writeFileSync(
			join(dir, "golden-diff", "evil", "result.json"),
			JSON.stringify({
				case: "runs.desktop.dark",
				page: "runs",
				viewport: "desktop",
				theme: "dark",
			}),
		);
		expect(readFailures(dir).map((f) => f.name)).toEqual([
			"agents.phone.light",
			"runs.desktop.light",
		]);
	});
});

describe("runCommentJob", () => {
	test("posts crops to the artifact branch and one sticky comment", async () => {
		const { api, deps } = setup("failure", artifact(5, ["runs.desktop.light"]));
		expect(await runCommentJob(deps)).toBe("post-failures:created");
		const [comment] = api.comments.get(5) ?? [];
		expect(comment?.body.startsWith(UI_VISUAL_MARKER)).toBe(true);
		expect(comment?.body).toContain("| `runs` | desktop | light | 0.20% |");
		const path = `2026-10-08/pr-5/${SHA.slice(0, 12)}/runs.desktop.light.png`;
		expect(comment?.body).toContain(
			`https://raw.githubusercontent.com/o/r/${ARTIFACT_BRANCH}/${path}`,
		);
		const crop = decodePng(Buffer.from(api.files(ARTIFACT_BRANCH).get(path) ?? "", "base64"));
		expect(crop.height).toBe(1 + 2 * 24);
	});

	test("edits the same comment on a later clean run", async () => {
		const failing = setup("failure", artifact(5, ["runs.desktop.light"]));
		await runCommentJob(failing.deps);
		const clean = setup("success", artifact(5, []));
		const comments = failing.api.comments.get(5) ?? [];
		clean.api.comments.set(5, comments);
		expect(await runCommentJob(clean.deps)).toBe("resolve:updated");
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toContain("golden screenshots match");
	});

	test("stays quiet on a clean PR that never failed", async () => {
		const { api, deps } = setup("success", artifact(5, []));
		expect(await runCommentJob(deps)).toBe("none");
		expect(api.comments.get(5)).toBeUndefined();
	});

	test("ignores an artifact that names a PR at another head", async () => {
		const { api, deps, log } = setup("failure", artifact(5, ["runs.desktop.light"]));
		api.pulls.set(5, { state: "open", head: { sha: "b".repeat(40) } });
		expect(await runCommentJob(deps)).toBe("skipped");
		expect(log.join("\n")).toContain("not this run's");
		expect(api.comments.get(5)).toBeUndefined();
	});

	test("skips push runs, cancelled runs, other workflows, and missing artifacts", async () => {
		expect(await runCommentJob(setup("failure", artifact(null, [])).deps)).toBe("skipped");
		expect(await runCommentJob(setup("cancelled", artifact(5, [])).deps)).toBe("skipped");
		expect(await runCommentJob(setup("failure", null).deps)).toBe("skipped");
		const other = setup("failure", artifact(5, []));
		other.api.runs.set("99", {
			path: ".github/workflows/ci.yml",
			status: "completed",
			conclusion: "failure",
		});
		expect(await runCommentJob(other.deps)).toBe("skipped");
	});

	test("still comments, linking the artifact, when the branch push fails", async () => {
		const { api, deps, log } = setup("failure", artifact(5, ["runs.desktop.light"]));
		api.request = (
			(orig) => (method, path, body) =>
				path.includes("/git/") ? Promise.reject(new Error("denied")) : orig(method, path, body)
		)(api.request.bind(api));
		expect(await runCommentJob(deps)).toBe("post-failures:created");
		expect(api.comments.get(5)?.[0]?.body).toContain(
			"| `runs` | desktop | light | 0.20% | artifact |",
		);
		expect(log.join("\n")).toContain("could not publish crops");
	});
});

/** Runtime (non-type) import specifiers reachable from `file`. */
function runtimeImports(file: string, seen = new Set<string>()): string[] {
	if (seen.has(file)) return [];
	seen.add(file);
	const source = readFileSync(file, "utf8");
	const specs = [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map(
		(m) => m[1] ?? "",
	);
	return specs.flatMap((spec) =>
		spec.startsWith(".") ? runtimeImports(resolve(dirname(file), spec), seen) : [spec],
	);
}

describe("the comment job's import graph", () => {
	test("reaches no package, so the workflow can skip bun install", () => {
		const external = runtimeImports(resolve(import.meta.dir, "pr-comment.ts"));
		expect(external.length).toBeGreaterThan(3);
		expect(external.filter((spec) => !spec.startsWith("node:"))).toEqual([]);
	});
});
