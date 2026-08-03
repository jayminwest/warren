/**
 * Preview-environment transition guard (warren-66d2). The table lives beside
 * the runs repo in `./runs.ts`; this suite pins both the pure assert and the
 * `attachPreview` enforcement path.
 */
import { describe, expect, test } from "bun:test";
import { StateTransitionError } from "../../core/errors.ts";
import { withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { assertPreviewTransition, RunsRepo } from "./runs.ts";

describe("assertPreviewTransition", () => {
	test("allows the launch path an unset row walks (warren-66d2)", () => {
		expect(() => assertPreviewTransition(null, "starting")).not.toThrow();
		expect(() => assertPreviewTransition(null, "failed")).not.toThrow();
		expect(() => assertPreviewTransition("starting", "live")).not.toThrow();
		expect(() => assertPreviewTransition("starting", "failed")).not.toThrow();
	});

	test("allows teardown from either active state", () => {
		expect(() => assertPreviewTransition("starting", "torn-down")).not.toThrow();
		expect(() => assertPreviewTransition("live", "torn-down")).not.toThrow();
	});

	test("allows a relaunch to re-enter at starting", () => {
		expect(() => assertPreviewTransition("failed", "starting")).not.toThrow();
		expect(() => assertPreviewTransition("torn-down", "starting")).not.toThrow();
	});

	test("refuses torn-down → live", () => {
		expect(() => assertPreviewTransition("torn-down", "live")).toThrow(StateTransitionError);
	});

	test("refuses torn-down → failed and live → starting", () => {
		expect(() => assertPreviewTransition("torn-down", "failed")).toThrow(StateTransitionError);
		expect(() => assertPreviewTransition("live", "starting")).toThrow(StateTransitionError);
	});

	test("a same-state write is an idempotent re-assert", () => {
		for (const state of ["starting", "live", "failed", "torn-down"] as const) {
			expect(() => assertPreviewTransition(state, state)).not.toThrow();
		}
	});
});

async function open() {
	const handle = await withDb({ dialect: "sqlite" });
	const adapter = DrizzleAdapter.for(handle.db);
	const agents = new AgentsRepo(adapter);
	const projects = new ProjectsRepo(adapter);
	const repo = new RunsRepo(adapter);
	const agent = await agents.upsert({ name: "claude-code", renderedJson: { sections: {} } });
	const project = await projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const row = await repo.create({
		agentName: agent.name,
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: { sections: {} },
		trigger: "manual",
	});
	return { handle, repo, row };
}

describe("RunsRepo.attachPreview transition enforcement", () => {
	test("refuses torn-down \u2192 live (warren-66d2)", async () => {
		const { handle, repo, row } = await open();
		try {
			await repo.attachPreview(row.id, { previewState: "starting", previewPort: 48210 });
			await repo.attachPreview(row.id, { previewState: "live" });
			await repo.attachPreview(row.id, { previewState: "torn-down", previewPort: null });
			await expect(repo.attachPreview(row.id, { previewState: "live" })).rejects.toThrow(
				StateTransitionError,
			);
			const reread = await repo.require(row.id);
			expect(reread.previewState).toBe("torn-down");
		} finally {
			await handle.close();
		}
	});

	test("leaves a state-free patch unguarded (proxy last-hit path)", async () => {
		const { handle, repo, row } = await open();
		try {
			await repo.attachPreview(row.id, { previewState: "starting" });
			await repo.attachPreview(row.id, { previewState: "torn-down" });
			const hit = "2026-08-02T18:05:00.000Z";
			const touched = await repo.attachPreview(row.id, { previewLastHitAt: hit });
			expect(touched.previewLastHitAt).toBe(hit);
			expect(touched.previewState).toBe("torn-down");
		} finally {
			await handle.close();
		}
	});

	test("allows the real launch walk starting \u2192 live", async () => {
		const { handle, repo, row } = await open();
		try {
			await repo.attachPreview(row.id, { previewState: "starting", previewPort: 48211 });
			const live = await repo.attachPreview(row.id, { previewState: "live" });
			expect(live.previewState).toBe("live");
		} finally {
			await handle.close();
		}
	});
});
