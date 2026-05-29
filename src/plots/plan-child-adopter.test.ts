/**
 * Unit tests for `defaultPlanChildAdopter` (warren-18a9).
 *
 * Exercises the reconciliation path against a real `@os-eco/plot-cli`
 * `.plot/` fixture, with a stubbed `sd plan show` shell-out so the
 * plan→children mapping is controlled per-test.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserPlotClient } from "../plot-client/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import { defaultPlanChildAdopter, isSdPlanAttachmentRef } from "./plan-child-adopter.ts";

/** Build a Plot fixture with the supplied seeds_issue attachments. */
async function seedPlot(dir: string, attachRefs: readonly string[]): Promise<string> {
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	const seeded = await client.create({ name: "T" });
	const handle = client.get(seeded.id);
	for (const ref of attachRefs) {
		await handle.attach({ type: "seeds_issue", ref, role: "tracks" });
	}
	client.close();
	return seeded.id;
}

async function readRefs(dir: string, plotId: string): Promise<string[]> {
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	const plot = await client.get(plotId).read();
	client.close();
	return plot.attachments.filter((a) => a.type === "seeds_issue").map((a) => a.ref);
}

/** Stub `sd plan show <id> --json` returning the supplied children per plan id. */
function fakeSeedsCli(plans: Record<string, readonly string[]>): SeedsCliDeps {
	const spawn: SpawnFn = async (cmd) => {
		const planId = cmd[3];
		if (cmd[1] === "plan" && cmd[2] === "show" && planId !== undefined && planId in plans) {
			const children = plans[planId] ?? [];
			return {
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({ plan: { id: planId, status: "approved", children } }),
			};
		}
		return { exitCode: 1, stderr: `unknown plan ${planId}`, stdout: "" };
	};
	return { sdBinary: "sd", spawn };
}

describe("isSdPlanAttachmentRef", () => {
	test("matches seeds_issue refs shaped like a plan id", () => {
		expect(
			isSdPlanAttachmentRef({
				id: "att-1",
				type: "seeds_issue",
				ref: "pl-df2f",
				role: "tracks",
				added_at: "x",
				added_by: "user:a",
			}),
		).toBe(true);
	});

	test("rejects non-plan seeds_issue refs and non-seeds attachments", () => {
		expect(
			isSdPlanAttachmentRef({
				id: "att-2",
				type: "seeds_issue",
				ref: "warren-bdfd",
				role: "tracks",
				added_at: "x",
				added_by: "user:a",
			}),
		).toBe(false);
		expect(
			isSdPlanAttachmentRef({
				id: "att-3",
				type: "mulch_record",
				ref: "pl-df2f",
				role: "tracks",
				added_at: "x",
				added_by: "user:a",
			}),
		).toBe(false);
	});
});

describe("defaultPlanChildAdopter.adopt", () => {
	test("attaches plan children missing from the Plot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-adopt-"));
		try {
			const plotId = await seedPlot(dir, ["pl-df2f"]);
			const result = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				seedsCli: fakeSeedsCli({ "pl-df2f": ["warren-bdfd", "warren-aaaa"] }),
			});
			expect(result.adopted).toEqual(["warren-bdfd", "warren-aaaa"]);
			const refs = await readRefs(dir, plotId);
			expect(refs.sort()).toEqual(["pl-df2f", "warren-aaaa", "warren-bdfd"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is idempotent: already-attached children are not re-adopted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-adopt-idem-"));
		try {
			const plotId = await seedPlot(dir, ["pl-df2f", "warren-bdfd"]);
			const result = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				seedsCli: fakeSeedsCli({ "pl-df2f": ["warren-bdfd", "warren-aaaa"] }),
			});
			expect(result.adopted).toEqual(["warren-aaaa"]);
			const second = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				seedsCli: fakeSeedsCli({ "pl-df2f": ["warren-bdfd", "warren-aaaa"] }),
			});
			expect(second.adopted).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no-op when the Plot has no sd_plan attachments", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-adopt-none-"));
		try {
			const plotId = await seedPlot(dir, ["warren-bdfd"]);
			const result = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				seedsCli: fakeSeedsCli({ "pl-df2f": ["warren-aaaa"] }),
			});
			expect(result.adopted).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips pl-* shaped children (sub-plans are not adopted as seeds)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-adopt-subplan-"));
		try {
			const plotId = await seedPlot(dir, ["pl-df2f"]);
			const result = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				seedsCli: fakeSeedsCli({ "pl-df2f": ["pl-nested", "warren-bdfd"] }),
			});
			expect(result.adopted).toEqual(["warren-bdfd"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failing plan read is skipped without aborting other plans", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-adopt-skip-"));
		try {
			const plotId = await seedPlot(dir, ["pl-good", "pl-bad"]);
			const result = await defaultPlanChildAdopter.adopt({
				plotDir: dir,
				projectPath: dir,
				plotId,
				handle: "alice",
				// pl-bad is absent from the stub → sd exits non-zero → skipped.
				seedsCli: fakeSeedsCli({ "pl-good": ["warren-good"] }),
			});
			expect(result.adopted).toEqual(["warren-good"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
