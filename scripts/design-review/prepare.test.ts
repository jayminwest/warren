import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGhApi } from "../ui-visual/fake-gh-api.ts";
import { buildDiff, type PrepareDeps, runPrepare } from "./prepare.ts";
import { SHA } from "./test-fixtures.ts";
import { caseNames } from "./verdict.ts";

const REPO = "o/r";
const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "design-review-prepare-"));
	temps.push(dir);
	return dir;
}

/** A ui-visual artifact for PR 7 with every `runs` and `agents` screenshot. */
function artifact(pr: unknown = 7): string {
	const dir = temp();
	mkdirSync(join(dir, "screenshots"));
	writeFileSync(join(dir, "ci-meta.json"), JSON.stringify({ pr, headSha: SHA }));
	for (const name of [...caseNames("runs"), ...caseNames("agents")]) {
		writeFileSync(join(dir, "screenshots", `${name}.png`), "png");
	}
	return dir;
}

interface Setup {
	conclusion?: string;
	files?: unknown[];
	changed?: number;
	state?: string;
	allowClosed?: boolean;
	pr?: unknown;
}

function setup(opts: Setup = {}) {
	const api = new FakeGhApi();
	const files = opts.files ?? [
		{ filename: "src/ui/src/pages/runs.tsx", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
		{ filename: "src/server/main.ts", status: "modified", patch: "@@ server @@" },
	];
	api.runs.set("99", {
		path: ".github/workflows/ui-visual.yml",
		status: "completed",
		conclusion: opts.conclusion ?? "success",
		head_sha: SHA,
		html_url: "https://example.test/runs/99",
	});
	api.pulls.set(7, {
		state: opts.state ?? "open",
		head: { sha: SHA },
		changed_files: opts.changed ?? files.length,
	});
	api.pullFiles.set(7, files);
	const outputs: Record<string, string> = {};
	const outDir = join(temp(), "out");
	const art = artifact(opts.pr);
	const deps: PrepareDeps = {
		api,
		repo: REPO,
		runId: "99",
		download: (name) => Promise.resolve(name === `ui-screenshots-${SHA}` ? art : null),
		now: new Date(0),
		log: () => {},
		outDir,
		output: (key, value) => {
			outputs[key] = value;
		},
		reviewUrl: "https://example.test/runs/100",
		allowClosed: opts.allowClosed ?? false,
	};
	return { api, deps, outputs, outDir };
}

describe("runPrepare", () => {
	test("stages only the in-scope screenshots, the file list, and the UI diff", async () => {
		const { api, deps, outputs, outDir } = setup();
		expect(await runPrepare(deps)).toBe("review");
		expect(outputs).toMatchObject({
			pr: "7",
			head_sha: SHA,
			pages: "runs",
			all_pages: "false",
			mode: "review",
		});
		const shots = readdirSync(join(outDir, "artifact", "screenshots")).sort();
		expect(shots).toEqual(
			caseNames("runs")
				.map((n) => `${n}.png`)
				.sort(),
		);
		expect(existsSync(join(outDir, "artifact", "ci-meta.json"))).toBe(true);
		expect(readFileSync(join(outDir, "changed-files.txt"), "utf8")).toContain("src/server/main.ts");
		const diff = readFileSync(join(outDir, "ui.diff"), "utf8");
		expect(diff).toContain("+++ b/src/ui/src/pages/runs.tsx");
		expect(diff).not.toContain("server");
		expect(api.checkRuns[0]).toMatchObject({
			status: "in_progress",
			details_url: "https://example.test/runs/100",
		});
	});

	test("skips a PR whose ui-visual run had nothing rendered to review", async () => {
		const { api, deps, outputs, outDir } = setup({
			files: [{ filename: "src/ui/README.md", status: "modified" }],
		});
		expect(await runPrepare(deps)).toBe("skip");
		expect(outputs.skip_reason).toBe("no-rendered-changes");
		expect(existsSync(outDir)).toBe(false);
		expect(api.checkRuns).toEqual([]);
	});

	test("reports not-run, without staging, when ui-visual failed", async () => {
		const { deps, outDir } = setup({ conclusion: "failure" });
		expect(await runPrepare(deps)).toBe("not-run");
		expect(existsSync(outDir)).toBe(false);
	});

	test("reviews every page when GitHub capped the file list", async () => {
		const { deps, outputs } = setup({ changed: 4000 });
		expect(await runPrepare(deps)).toBe("review");
		expect(outputs.all_pages).toBe("true");
		expect(outputs.pages?.split(",").length).toBeGreaterThan(10);
	});

	test("reports nothing for a PR that moved on, closed, or is not named", async () => {
		const moved = setup();
		moved.api.pulls.set(7, { state: "open", head: { sha: "f".repeat(40) } });
		expect(await runPrepare(moved.deps)).toBe("none");
		expect(moved.outputs).toEqual({});
		expect(await runPrepare(setup({ state: "closed" }).deps)).toBe("none");
		expect(await runPrepare(setup({ pr: null }).deps)).toBe("none");
	});

	test("reviews a merged PR's last head only on a manual allow-closed dispatch", async () => {
		expect(await runPrepare(setup({ state: "closed", allowClosed: true }).deps)).toBe("review");
	});
});

describe("buildDiff", () => {
	const files = [
		{ filename: "a.tsx", status: "modified", patch: "x".repeat(50) },
		{ filename: "b.png", status: "added" },
		{ filename: "c.tsx", status: "modified", patch: "y".repeat(50) },
	];

	test("notes files GitHub gave no patch for", () => {
		expect(buildDiff(files, ["b.png"])).toBe(
			"# b.png: added, no patch from GitHub (binary or too large)\n",
		);
	});

	test("stops at the cap and says so", () => {
		const out = buildDiff(files, ["a.tsx", "c.tsx"], 150);
		expect(out).toContain("a.tsx");
		expect(out).not.toContain("c.tsx");
		expect(out).toContain("diff truncated at 150 characters");
	});
});
