/**
 * Unit tests for the SPEC \u00a76.5 transition matrix
 * (`assertStatusTransitionAllowed` / `STATUS_TRANSITIONS`) and the
 * production `defaultPlotStatusChanger`'s round-trip behavior via a
 * real `@os-eco/plot-cli` `.plot/` fixture (warren-e868 / pl-9d6a
 * step 10).
 *
 * The matrix pin lives here rather than the handler layer because the
 * handler delegates the actual check to the changer; the handler test
 * verifies that the SPEC \u00a76.5 envelope shape (409 +
 * `plot_illegal_status_transition`) reaches the wire.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { PlotIllegalStatusTransitionError } from "./errors.ts";
import {
	assertStatusTransitionAllowed,
	defaultPlotStatusChanger,
	isLegalStatusTransition,
	STATUS_TRANSITIONS,
} from "./status-changer.ts";

const ALL_STATUSES: readonly PlotStatus[] = ["drafting", "ready", "active", "done", "archived"];

const EXPECTED_MATRIX: Readonly<Record<PlotStatus, readonly PlotStatus[]>> = {
	drafting: ["ready", "archived"],
	ready: ["active", "archived"],
	active: ["done", "archived"],
	done: ["archived"],
	archived: [],
};

describe("STATUS_TRANSITIONS (SPEC \u00a76.5)", () => {
	test("matrix is the byte-identical SPEC \u00a76.5 whitelist", () => {
		expect(STATUS_TRANSITIONS).toEqual(EXPECTED_MATRIX);
	});

	test("every (from, to) pair with from === to is rejected (no self-loops)", () => {
		for (const s of ALL_STATUSES) {
			expect(isLegalStatusTransition(s, s)).toBe(false);
		}
	});

	test("every back-edge is rejected (drafting unreachable from ready/active/done/archived; etc.)", () => {
		const backEdges: ReadonlyArray<[PlotStatus, PlotStatus]> = [
			["ready", "drafting"],
			["active", "drafting"],
			["active", "ready"],
			["done", "drafting"],
			["done", "ready"],
			["done", "active"],
			["archived", "drafting"],
			["archived", "ready"],
			["archived", "active"],
			["archived", "done"],
		];
		for (const [from, to] of backEdges) {
			expect(isLegalStatusTransition(from, to)).toBe(false);
		}
	});

	test("archived is terminal", () => {
		for (const to of ALL_STATUSES) {
			expect(isLegalStatusTransition("archived", to)).toBe(false);
		}
	});
});

describe("assertStatusTransitionAllowed", () => {
	test("permits every (from, to) entry in the whitelist", () => {
		for (const from of ALL_STATUSES) {
			for (const to of EXPECTED_MATRIX[from]) {
				expect(() => assertStatusTransitionAllowed("pt-x", from, to)).not.toThrow();
			}
		}
	});

	test("throws PlotIllegalStatusTransitionError on illegal transitions", () => {
		expect(() => assertStatusTransitionAllowed("pt-x", "drafting", "active")).toThrow(
			PlotIllegalStatusTransitionError,
		);
		expect(() => assertStatusTransitionAllowed("pt-x", "active", "drafting")).toThrow(
			PlotIllegalStatusTransitionError,
		);
		expect(() => assertStatusTransitionAllowed("pt-x", "done", "active")).toThrow(
			PlotIllegalStatusTransitionError,
		);
		expect(() => assertStatusTransitionAllowed("pt-x", "archived", "archived")).toThrow(
			PlotIllegalStatusTransitionError,
		);
	});

	test("message includes the plot id and the legal-from hint", () => {
		try {
			assertStatusTransitionAllowed("pt-abc", "active", "ready");
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof PlotIllegalStatusTransitionError)) throw err;
			expect(err.message).toContain("pt-abc");
			expect(err.message).toContain("active");
			expect(err.message).toContain("ready");
			expect(err.recoveryHint).toContain("done");
			expect(err.recoveryHint).toContain("archived");
		}
	});

	test("terminal-archived hint differs from non-terminal hints", () => {
		try {
			assertStatusTransitionAllowed("pt-arc", "archived", "done");
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof PlotIllegalStatusTransitionError)) throw err;
			expect(err.recoveryHint).toContain("terminal");
		}
	});
});

describe("defaultPlotStatusChanger", () => {
	test("round-trip: drafting \u2192 ready emits status_changed and returns the summary subset", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-status-change-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "S" });
			seedClient.close();

			const result = await defaultPlotStatusChanger.change({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				next: "ready",
			});

			expect(result.id).toBe(seeded.id);
			expect(result.status).toBe("ready");
			expect(result.event.type).toBe("status_changed");
			expect(result.event.actor).toBe("user:alice");
			const data = result.event.data as { from?: string; to?: string };
			expect(data.to).toBe("ready");
			expect(data.from).toBe("drafting");
			expect(result.last_event_actor).toBe("user:alice");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects illegal transition (drafting \u2192 done) before calling the lib", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-status-illegal-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Bad" });
			seedClient.close();

			await expect(
				defaultPlotStatusChanger.change({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					next: "done",
				}),
			).rejects.toBeInstanceOf(PlotIllegalStatusTransitionError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects archived terminal (archived \u2192 anything throws)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-status-terminal-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Term" });
			const handle = seedClient.get(seeded.id);
			await handle.setStatus("archived");
			seedClient.close();

			await expect(
				defaultPlotStatusChanger.change({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					next: "done",
				}),
			).rejects.toBeInstanceOf(PlotIllegalStatusTransitionError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
