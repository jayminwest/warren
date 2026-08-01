import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { type AnyWarrenDb, openDatabase } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import { isPostgresTestEnabled, withDb } from "../db/testing.ts";
import {
	DEFAULT_PREVIEW_PORT_RANGE,
	loadPreviewPortRangeFromEnv,
	PORT_EXHAUSTED_REASON,
	PREVIEW_PORT_USAGE_WARN_RATIO,
	PreviewPortAllocator,
	parsePortRange,
	rangeSize,
	WARREN_PREVIEW_PORT_RANGE_ENV,
} from "./port-allocator.ts";

describe("parsePortRange", () => {
	test("accepts <start>-<end>", () => {
		expect(parsePortRange("30000-31000")).toEqual({ start: 30000, end: 31000 });
	});

	test("accepts whitespace around the dash", () => {
		expect(parsePortRange(" 30000 - 31000 ")).toEqual({ start: 30000, end: 31000 });
	});

	test("accepts a single-port range", () => {
		expect(parsePortRange("4000-4000")).toEqual({ start: 4000, end: 4000 });
	});

	test("rejects malformed input", () => {
		expect(() => parsePortRange("not-a-range")).toThrow(ValidationError);
		expect(() => parsePortRange("30000")).toThrow(ValidationError);
		expect(() => parsePortRange("30000-")).toThrow(ValidationError);
		expect(() => parsePortRange("")).toThrow(ValidationError);
	});

	test("rejects out-of-range bounds", () => {
		expect(() => parsePortRange("0-100")).toThrow(ValidationError);
		expect(() => parsePortRange("100-99999")).toThrow(ValidationError);
	});

	test("rejects start > end", () => {
		expect(() => parsePortRange("31000-30000")).toThrow(ValidationError);
	});
});

describe("loadPreviewPortRangeFromEnv", () => {
	test("unset falls back to default", () => {
		expect(loadPreviewPortRangeFromEnv({})).toEqual(DEFAULT_PREVIEW_PORT_RANGE);
	});

	test("empty / whitespace falls back to default", () => {
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "" })).toEqual(
			DEFAULT_PREVIEW_PORT_RANGE,
		);
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "   " })).toEqual(
			DEFAULT_PREVIEW_PORT_RANGE,
		);
	});

	test("valid env override is parsed", () => {
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "40000-40100" })).toEqual(
			{
				start: 40000,
				end: 40100,
			},
		);
	});

	test("malformed env throws ValidationError", () => {
		expect(() =>
			loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "garbage" }),
		).toThrow(ValidationError);
	});
});

describe("rangeSize", () => {
	test("inclusive on both ends", () => {
		expect(rangeSize({ start: 30000, end: 31000 })).toBe(1001);
		expect(rangeSize({ start: 4000, end: 4000 })).toBe(1);
	});
});

describe("constants", () => {
	test("PORT_EXHAUSTED_REASON matches docs/design/preview-environments.md wording", () => {
		expect(PORT_EXHAUSTED_REASON).toBe("port_exhausted");
	});

	test("warn ratio matches docs/design/preview-environments.md (≥80%)", () => {
		expect(PREVIEW_PORT_USAGE_WARN_RATIO).toBe(0.8);
	});
});

/**
 * Construction-arg validation runs against any sqlite-typed handle and
 * doesn't touch the db, so it lives outside the dialect-polymorphic suite.
 */
describe("PreviewPortAllocator (construction)", () => {
	let db: AnyWarrenDb;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
	});
	afterEach(async () => {
		await db.close();
	});

	test("rejects a range outside the valid TCP space", () => {
		const adapter = DrizzleAdapter.for(db);
		expect(() => new PreviewPortAllocator(adapter, { start: 0, end: 10 })).toThrow(ValidationError);
		expect(() => new PreviewPortAllocator(adapter, { start: 10, end: 5 })).toThrow(ValidationError);
	});
});

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`PreviewPortAllocator (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const a = await agents.upsert({ name: "preview-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const runsRepo = new RunsRepo(adapter);
			return { handle, adapter, runsRepo, agentName: a.name, projectId: p.id };
		};

		async function spawn(
			runsRepo: RunsRepo,
			agentName: string,
			projectId: string,
		): Promise<{ id: string }> {
			return runsRepo.create({
				agentName,
				projectId,
				prompt: "preview please",
				renderedAgentJson: { sections: {} },
				trigger: "manual",
			});
		}

		test("allocates the lowest free port and writes preview state", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40002 });
				const run = await spawn(runsRepo, agentName, projectId);
				const now = new Date("2026-05-14T18:00:00.000Z");
				const outcome = await allocator.allocate(run.id, now);
				expect(outcome).toEqual({ status: "allocated", port: 40000 });

				const reread = await runsRepo.require(run.id);
				expect(reread.previewPort).toBe(40000);
				expect(reread.previewState).toBe("starting");
				expect(reread.previewStartedAt).toBe(now.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("skips ports already in use by starting/live runs", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40005 });
				const inUse = await spawn(runsRepo, agentName, projectId);
				await runsRepo.attachPreview(inUse.id, { previewState: "starting", previewPort: 40000 });
				const live = await spawn(runsRepo, agentName, projectId);
				await runsRepo.attachPreview(live.id, { previewState: "live", previewPort: 40001 });

				const candidate = await spawn(runsRepo, agentName, projectId);
				const outcome = await allocator.allocate(candidate.id);
				expect(outcome).toEqual({ status: "allocated", port: 40002 });
			} finally {
				await handle.close();
			}
		});

		test("released ports (state torn-down/failed) are re-allocatable", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40000 });
				const first = await spawn(runsRepo, agentName, projectId);
				const ok1 = await allocator.allocate(first.id);
				expect(ok1).toEqual({ status: "allocated", port: 40000 });

				await runsRepo.attachPreview(first.id, {
					previewState: "torn-down",
					previewPort: null,
				});

				const second = await spawn(runsRepo, agentName, projectId);
				const ok2 = await allocator.allocate(second.id);
				expect(ok2).toEqual({ status: "allocated", port: 40000 });
			} finally {
				await handle.close();
			}
		});

		test("a stale port left behind on a failed run is still considered free", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40000 });
				const failed = await spawn(runsRepo, agentName, projectId);
				await runsRepo.attachPreview(failed.id, {
					previewState: "failed",
					previewPort: 40000,
					previewFailureMessage: "boot crashed",
				});

				const next = await spawn(runsRepo, agentName, projectId);
				expect(await allocator.allocate(next.id)).toEqual({ status: "allocated", port: 40000 });
			} finally {
				await handle.close();
			}
		});

		test("returns exhausted when every port is in use", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40001 });
				const a = await spawn(runsRepo, agentName, projectId);
				const b = await spawn(runsRepo, agentName, projectId);
				await runsRepo.attachPreview(a.id, { previewState: "starting", previewPort: 40000 });
				await runsRepo.attachPreview(b.id, { previewState: "live", previewPort: 40001 });

				const candidate = await spawn(runsRepo, agentName, projectId);
				expect(await allocator.allocate(candidate.id)).toEqual({ status: "exhausted" });

				const reread = await runsRepo.require(candidate.id);
				expect(reread.previewPort).toBeNull();
				expect(reread.previewState).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("throws NotFoundError for an unknown run id", async () => {
			const { handle, adapter } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter);
				await expect(allocator.allocate("run_doesnotexist")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("is idempotent for a run already holding a port (starting/live)", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40010 });
				const run = await spawn(runsRepo, agentName, projectId);
				const startedAt = "2026-05-14T18:00:00.000Z";
				await runsRepo.attachPreview(run.id, {
					previewState: "starting",
					previewPort: 40005,
					previewStartedAt: startedAt,
				});
				const outcome = await allocator.allocate(run.id, new Date("2026-05-14T19:00:00.000Z"));
				expect(outcome).toEqual({ status: "allocated", port: 40005 });

				const reread = await runsRepo.require(run.id);
				expect(reread.previewStartedAt).toBe(startedAt);
			} finally {
				await handle.close();
			}
		});

		test("restart-safety: a fresh allocator instance sees committed in-use ports", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const a1 = new PreviewPortAllocator(adapter, { start: 40000, end: 40010 });
				const r1 = await spawn(runsRepo, agentName, projectId);
				const r2 = await spawn(runsRepo, agentName, projectId);
				await a1.allocate(r1.id);
				await a1.allocate(r2.id);

				const a2 = new PreviewPortAllocator(adapter, { start: 40000, end: 40010 });
				const r3 = await spawn(runsRepo, agentName, projectId);
				const outcome = await a2.allocate(r3.id);
				expect(outcome).toEqual({ status: "allocated", port: 40002 });
			} finally {
				await handle.close();
			}
		});

		test("usage reports inUse count and total range size", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40009 });
				expect(await allocator.usage()).toEqual({
					inUse: 0,
					total: 10,
					range: { start: 40000, end: 40009 },
				});

				for (let i = 0; i < 8; i += 1) {
					const run = await spawn(runsRepo, agentName, projectId);
					await allocator.allocate(run.id);
				}
				const usage = await allocator.usage();
				expect(usage.inUse).toBe(8);
				expect(usage.total).toBe(10);
				expect(usage.inUse / usage.total).toBe(0.8);
			} finally {
				await handle.close();
			}
		});

		test("usage de-duplicates would-be duplicate ports (defensive)", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const allocator = new PreviewPortAllocator(adapter, { start: 40000, end: 40005 });
				const a = await spawn(runsRepo, agentName, projectId);
				const b = await spawn(runsRepo, agentName, projectId);
				await runsRepo.attachPreview(a.id, { previewState: "starting", previewPort: 40000 });
				await runsRepo.attachPreview(b.id, { previewState: "live", previewPort: 40000 });
				const usage = await allocator.usage();
				expect(usage.inUse).toBe(1);
			} finally {
				await handle.close();
			}
		});

		test("concurrent allocations against the same db never double-allocate a port", async () => {
			const { handle, adapter, runsRepo, agentName, projectId } = await open();
			try {
				const range = { start: 40000, end: 40019 };
				const allocator = new PreviewPortAllocator(adapter, range);
				const candidates = await Promise.all(
					Array.from({ length: 20 }, () => spawn(runsRepo, agentName, projectId)),
				);
				const outcomes = await Promise.all(candidates.map((c) => allocator.allocate(c.id)));
				const ports = outcomes
					.map((o) => (o.status === "allocated" ? o.port : null))
					.filter((p): p is number => p !== null);
				expect(new Set(ports).size).toBe(20);
				expect(ports.every((p) => p >= range.start && p <= range.end)).toBe(true);
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
