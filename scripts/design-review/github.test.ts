import { describe, expect, test } from "bun:test";

import { FakeGhApi } from "../ui-visual/fake-gh-api.ts";
import { gateOutcome, runGate } from "./gate.ts";
import { listPrFiles, setCheck } from "./github.ts";
import { checkFor } from "./outcome.ts";
import { SHA } from "./test-fixtures.ts";

const REPO = "o/r";

function api(files: unknown[], changed = files.length): FakeGhApi {
	const fake = new FakeGhApi();
	fake.pulls.set(7, { state: "open", head: { sha: SHA }, changed_files: changed });
	fake.pullFiles.set(7, files);
	return fake;
}

describe("listPrFiles", () => {
	test("reads the filename field and keeps the patch", async () => {
		const fake = api([
			{ filename: "src/ui/src/pages/runs.tsx", status: "modified", patch: "@@ -1 +1 @@" },
			{ path: "ignored-wrong-field.ts" },
		]);
		const result = await listPrFiles(fake, REPO, 7);
		expect(result.files).toEqual([
			{ filename: "src/ui/src/pages/runs.tsx", status: "modified", patch: "@@ -1 +1 @@" },
		]);
		expect(result.complete).toBe(false);
	});

	test("reports a list GitHub capped below changed_files as incomplete", async () => {
		const fake = api([{ filename: "a.ts", status: "added" }], 3001);
		expect((await listPrFiles(fake, REPO, 7)).complete).toBe(false);
		expect((await listPrFiles(api([{ filename: "a.ts" }]), REPO, 7)).complete).toBe(true);
	});
});

describe("setCheck", () => {
	const queued = checkFor({ kind: "waiting" }, null);
	const done = checkFor({ kind: "skipped", reason: "no-ui-changes" }, null);

	test("creates the named check on the head sha", async () => {
		const fake = new FakeGhApi();
		expect(await setCheck(fake, REPO, SHA, done, { detailsUrl: "https://x" })).toBe("created");
		expect(fake.checkRuns).toEqual([
			expect.objectContaining({
				name: "design-review",
				head_sha: SHA,
				status: "completed",
				conclusion: "success",
				details_url: "https://x",
			}),
		]);
	});

	test("edits an open check in place", async () => {
		const fake = new FakeGhApi();
		await setCheck(fake, REPO, SHA, queued);
		expect(await setCheck(fake, REPO, SHA, done)).toBe("updated");
		expect(fake.checkRuns).toHaveLength(1);
		expect(fake.checkRuns[0]?.conclusion).toBe("success");
	});

	test("adds a new check rather than reopening a finished one", async () => {
		const fake = new FakeGhApi();
		await setCheck(fake, REPO, SHA, done);
		expect(await setCheck(fake, REPO, SHA, queued)).toBe("created");
		expect(fake.checkRuns.map((r) => r.status)).toEqual(["completed", "queued"]);
	});

	test("onlyIfAbsent keeps any existing check", async () => {
		const fake = new FakeGhApi();
		await setCheck(fake, REPO, SHA, done);
		expect(await setCheck(fake, REPO, SHA, queued, { onlyIfAbsent: true })).toBe("kept");
		expect(fake.checkRuns).toHaveLength(1);
	});

	test("falls back to the title when the summary is empty", async () => {
		const fake = new FakeGhApi();
		await setCheck(fake, REPO, SHA, { ...done, summary: "" });
		expect(fake.checkRuns[0]?.output?.summary).toBe(done.title);
	});
});

describe("gate", () => {
	test("skips PRs that leave src/ui alone or only touch its tests", () => {
		expect(gateOutcome(["src/server/main.ts"], true)).toEqual({
			kind: "skipped",
			reason: "no-ui-changes",
		});
		expect(gateOutcome(["src/ui/src/pages/runs.test.tsx"], true)).toEqual({
			kind: "skipped",
			reason: "no-rendered-changes",
		});
	});

	test("waits on a rendered UI change and on a capped file list", () => {
		expect(gateOutcome(["src/ui/src/pages/runs.tsx"], true)).toEqual({ kind: "waiting" });
		expect(gateOutcome(["src/server/main.ts"], false)).toEqual({ kind: "waiting" });
	});

	test("passes a non-UI PR at once so a required check never hangs", async () => {
		const fake = api([{ filename: "docs/x.md", status: "modified" }]);
		expect(await runGate(fake, REPO, 7, SHA)).toBe("skipped:created");
		expect(fake.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "success" });
	});

	test("queues a UI PR without clobbering a review that already finished", async () => {
		const fake = api([{ filename: "src/ui/src/pages/runs.tsx", status: "modified" }]);
		expect(await runGate(fake, REPO, 7, SHA)).toBe("waiting:created");
		expect(fake.checkRuns[0]?.status).toBe("queued");
		for (const run of fake.checkRuns) run.status = "completed";
		expect(await runGate(fake, REPO, 7, SHA)).toBe("waiting:kept");
		expect(fake.checkRuns).toHaveLength(1);
	});
});
