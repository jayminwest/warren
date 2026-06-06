import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { PlotsRepo } from "../db/repos/plots.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { withDb } from "../db/testing.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import { createPlotsProjectionSink } from "./projection-sink.ts";

function makePlotDir(): string {
	return mkdtempSync(join(tmpdir(), "warren-projection-sink-"));
}

async function openRepo() {
	const handle = await withDb({ dialect: "sqlite" });
	const adapter = DrizzleAdapter.for(handle.db);
	const projects = new ProjectsRepo(adapter);
	const repo = new PlotsRepo(adapter);
	const project = await projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { handle, repo, projectId: project.id };
}

describe("createPlotsProjectionSink", () => {
	test("reading a Plot populates the projection row from git state", async () => {
		const { handle, repo, projectId } = await openRepo();
		const dir = makePlotDir();
		const client = new UserPlotClient({
			dir,
			actor: { kind: "user", handle: "alice", raw: "user:alice" },
			projection: createPlotsProjectionSink({ repo, projectId }),
		});
		try {
			// create() goes through the projection on the read-after-create.
			const created = await client.create({ name: "Ship the thing" });
			const row = await repo.get(created.id);
			expect(row).not.toBeNull();
			expect(row?.projectId).toBe(projectId);
			expect(row?.title).toBe("Ship the thing");
			expect(row?.status).toBe("drafting");
			expect(row?.stateJson).toMatchObject({ id: created.id, name: "Ship the thing" });
		} finally {
			client.close();
			rmSync(dir, { recursive: true, force: true });
			handle.close();
		}
	});

	test("editing intent refreshes the projection row to match plot state", async () => {
		const { handle, repo, projectId } = await openRepo();
		const dir = makePlotDir();
		const client = new UserPlotClient({
			dir,
			actor: { kind: "user", handle: "alice", raw: "user:alice" },
			projection: createPlotsProjectionSink({ repo, projectId }),
		});
		try {
			const created = await client.create({ name: "Ship the thing" });
			const plotHandle = client.get(created.id);
			const edited = await plotHandle.editIntent({ goal: "Land warren-7b60" });

			const row = await repo.require(created.id);
			expect(row.updatedAt).toBe(edited.updated_at);
			expect(row.status).toBe(edited.status);
			expect(row.title).toBe(edited.name);
			// The blob mirrors the freshly-read git state verbatim.
			expect(row.stateJson).toMatchObject({
				id: created.id,
				intent: { goal: "Land warren-7b60" },
			});
		} finally {
			client.close();
			rmSync(dir, { recursive: true, force: true });
			handle.close();
		}
	});

	test("status change refreshes the promoted status scalar", async () => {
		const { handle, repo, projectId } = await openRepo();
		const dir = makePlotDir();
		const client = new UserPlotClient({
			dir,
			actor: { kind: "user", handle: "alice", raw: "user:alice" },
			projection: createPlotsProjectionSink({ repo, projectId }),
		});
		try {
			const created = await client.create({ name: "Ship the thing" });
			const plotHandle = client.get(created.id);
			const next = await plotHandle.setStatus("ready");

			const row = await repo.require(created.id);
			expect(row.status).toBe("ready");
			expect(row.status).toBe(next.status);
		} finally {
			client.close();
			rmSync(dir, { recursive: true, force: true });
			handle.close();
		}
	});

	test("projection failures are swallowed so the git write still succeeds", async () => {
		const dir = makePlotDir();
		const warnings: string[] = [];
		const failingRepo = {
			upsert: async () => {
				throw new Error("db offline");
			},
		} as unknown as PlotsRepo;
		const client = new UserPlotClient({
			dir,
			actor: { kind: "user", handle: "alice", raw: "user:alice" },
			projection: createPlotsProjectionSink({
				repo: failingRepo,
				projectId: "prj-1",
				logger: {
					info() {},
					warn(_obj, msg) {
						warnings.push(msg ?? "");
					},
					error() {},
				},
			}),
		});
		try {
			// The create must succeed even though the projection upsert throws.
			const created = await client.create({ name: "Resilient" });
			const plotHandle = client.get(created.id);
			const plot = await plotHandle.read();
			expect(plot.name).toBe("Resilient");
			expect(warnings.length).toBeGreaterThan(0);
		} finally {
			client.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
