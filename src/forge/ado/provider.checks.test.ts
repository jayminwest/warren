import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "../github/test-helpers.ts";
import { AdoForge } from "./provider.ts";
import { REPO_GUID } from "./stub-server.ts";
import { setup } from "./test-helpers.ts";

describe("AdoForge checks and logs", () => {
	test("listChecks keeps only the builds for the commit and rolls them up", async () => {
		const sha = "a".repeat(40);
		const { forge, ref } = setup({
			builds: [
				{
					id: 1,
					sourceVersion: sha,
					status: "completed",
					result: "succeeded",
					definitionName: "CI",
				},
				{
					id: 2,
					sourceVersion: sha,
					status: "completed",
					result: "failed",
					definitionName: "Lint",
				},
				{
					id: 3,
					sourceVersion: "b".repeat(40),
					status: "inProgress",
					result: null,
					definitionName: "CI",
				},
			],
		});
		const checks = await forge.listChecks(ref, sha);
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.conclusion).toBe("failing");
		expect(checks.value.runs.map((r) => [r.name, r.jobId])).toEqual([
			["CI", "1"],
			["Lint", "2"],
		]);
	});

	test("listChecks polls a branch ref server-side — the shape the ci-fixer passes", async () => {
		const sha = "c".repeat(40);
		const { forge, ref, stub } = setup({
			builds: [
				{
					id: 7,
					sourceVersion: sha,
					sourceBranch: "refs/heads/warren/run_1",
					status: "completed",
					result: "failed",
					definitionName: "CI",
				},
				{
					id: 8,
					sourceVersion: sha,
					sourceBranch: "refs/heads/main",
					status: "completed",
					result: "succeeded",
					definitionName: "CI",
				},
			],
		});
		const checks = await forge.listChecks(ref, "warren/run_1");
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.conclusion).toBe("failing");
		expect(checks.value.runs.map((r) => r.jobId)).toEqual(["7"]);
		expect(checks.value.runs[0]?.conclusion).toBe("failure");
		const buildCall = stub.state.calls.find((c) => c.url.includes("/build/builds"));
		expect(buildCall?.url).toContain("branchName=refs%2Fheads%2Fwarren%2Frun_1");
	});

	test("listChecks sees PR build-validation builds on the merge ref", async () => {
		const sha = "d".repeat(40);
		const { forge, ref } = setup({
			prs: [
				{
					pullRequestId: 12,
					title: "run_1",
					description: "",
					sourceRefName: "refs/heads/warren/run_1",
					targetRefName: "refs/heads/main",
					status: "active",
					closedDate: null,
					headSha: sha,
				},
			],
			builds: [
				{
					id: 9,
					sourceVersion: sha,
					sourceBranch: "refs/pull/12/merge",
					status: "completed",
					result: "failed",
					definitionName: "PR validation",
				},
			],
		});
		const checks = await forge.listChecks(ref, "warren/run_1");
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.conclusion).toBe("failing");
		expect(checks.value.runs.map((r) => r.jobId)).toEqual(["9"]);
	});

	test("listChecks lets a newer merge-ref build outrank an older branch build of the same definition", async () => {
		const sha = "a".repeat(40);
		const { forge, ref } = setup({
			prs: [
				{
					pullRequestId: 13,
					title: "run_3",
					description: "",
					sourceRefName: "refs/heads/warren/run_3",
					targetRefName: "refs/heads/main",
					status: "active",
					closedDate: null,
					headSha: sha,
				},
			],
			builds: [
				{
					id: 30,
					sourceVersion: sha,
					sourceBranch: "refs/heads/warren/run_3",
					status: "completed",
					result: "succeeded",
					definitionName: "CI",
					queueTime: "2026-09-01T10:00:00Z",
				},
				{
					id: 31,
					sourceVersion: sha,
					sourceBranch: "refs/pull/13/merge",
					status: "completed",
					result: "failed",
					definitionName: "CI",
					queueTime: "2026-09-01T10:05:00Z",
				},
			],
		});
		const checks = await forge.listChecks(ref, "warren/run_3");
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.conclusion).toBe("failing");
		expect(checks.value.runs.map((r) => r.jobId)).toEqual(["31"]);
	});

	test("listChecks keeps only the newest build per definition, so a fixed branch reads passing", async () => {
		const sha = "e".repeat(40);
		const { forge, ref } = setup({
			builds: [
				{
					id: 21,
					sourceVersion: sha,
					sourceBranch: "refs/heads/warren/run_2",
					status: "completed",
					result: "succeeded",
					definitionName: "CI",
				},
				{
					id: 20,
					sourceVersion: "f".repeat(40),
					sourceBranch: "refs/heads/warren/run_2",
					status: "completed",
					result: "failed",
					definitionName: "CI",
				},
			],
		});
		const checks = await forge.listChecks(ref, "warren/run_2");
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.conclusion).toBe("passing");
		expect(checks.value.runs.map((r) => r.jobId)).toEqual(["21"]);
	});

	test("listChecks scopes the build scan to the repository GUID", async () => {
		const sha = "1".repeat(40);
		const { forge, ref, stub } = setup({
			builds: [
				{
					id: 5,
					sourceVersion: sha,
					status: "completed",
					result: "succeeded",
					definitionName: "CI",
				},
			],
		});
		const checks = await forge.listChecks(ref, sha);
		expect(checks.ok).toBe(true);
		const buildCall = stub.state.calls.find((c) => c.url.includes("/build/builds"));
		expect(buildCall?.url).toContain(`repositoryId=${REPO_GUID}`);
		expect(buildCall?.url).toContain("repositoryType=TfsGit");
	});

	test("fetchJobLogTail tails the failed task's log to maxBytes", async () => {
		const { forge, ref, stub } = setup();
		const log = await forge.fetchJobLogTail(ref, "7", 64);
		expect(log.ok && log.value?.length).toBeLessThanOrEqual(64);
		expect(log.ok && log.value).toContain("log line 20");
		expect(stub.state.calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/acme/Widgets/_apis/build/builds/7/timeline",
			"/acme/Widgets/_apis/build/builds/7/logs/3",
		]);
	});

	test("fetchJobLogTail is best-effort: a zero budget and failures yield null", async () => {
		const { forge, ref } = setup();
		expect(await forge.fetchJobLogTail(ref, "7", 0)).toEqual({ ok: true, value: null });
		const { fetch } = recordingFetch([
			jsonResponse(500, {}),
			jsonResponse(500, {}),
			jsonResponse(500, {}),
		]);
		const failing = new AdoForge({ token: "t", fetch });
		expect(await failing.fetchJobLogTail(ref, "7", 64)).toEqual({ ok: true, value: null });
	});
});
