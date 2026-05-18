/**
 * Unit tests for `defaultPlotAttacher` (warren-589c / pl-9d6a step 11).
 *
 * Exercises the production attach/detach path against a real
 * `@os-eco/plot-cli` `.plot/` fixture so the ref→att-NNN mapping is
 * pinned at this layer rather than being mocked at the seam.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserPlotClient } from "../plot-client/index.ts";
import { defaultPlotAttacher } from "./attacher.ts";
import { PlotAttachmentNotFoundError } from "./errors.ts";

async function seedPlot(dir: string): Promise<string> {
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	const seeded = await client.create({ name: "T" });
	client.close();
	return seeded.id;
}

describe("defaultPlotAttacher.attach", () => {
	test("appends an attachment and surfaces it on the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-attach-"));
		try {
			const plotId = await seedPlot(dir);
			const result = await defaultPlotAttacher.attach({
				plotDir: dir,
				plotId,
				handle: "alice",
				kind: "seeds_issue",
				ref: "proj-abcd",
				role: "tracks",
			});
			expect(result.attachment.ref).toBe("proj-abcd");
			expect(result.attachment.role).toBe("tracks");
			expect(result.attachment.type).toBe("seeds_issue");
			expect(result.attachments).toHaveLength(1);
			expect(result.event_log.some((e) => e.type === "attachment_added")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults role to 'tracks' when omitted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-attach-default-role-"));
		try {
			const plotId = await seedPlot(dir);
			const result = await defaultPlotAttacher.attach({
				plotDir: dir,
				plotId,
				handle: "alice",
				kind: "mulch_record",
				ref: "mx-abc123",
			});
			expect(result.attachment.role).toBe("tracks");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("defaultPlotAttacher.detach", () => {
	test("removes the attachment with matching ref", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-detach-"));
		try {
			const plotId = await seedPlot(dir);
			const attached = await defaultPlotAttacher.attach({
				plotDir: dir,
				plotId,
				handle: "alice",
				kind: "seeds_issue",
				ref: "proj-1234",
			});
			expect(attached.attachments).toHaveLength(1);

			const result = await defaultPlotAttacher.detach({
				plotDir: dir,
				plotId,
				handle: "alice",
				ref: "proj-1234",
			});
			expect(result.attachments).toHaveLength(0);
			expect(result.removed_id).toBe(attached.attachment.id);
			expect(result.event_log.some((e) => e.type === "attachment_removed")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws PlotAttachmentNotFoundError when ref does not match", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-detach-missing-"));
		try {
			const plotId = await seedPlot(dir);
			await expect(
				defaultPlotAttacher.detach({
					plotDir: dir,
					plotId,
					handle: "alice",
					ref: "proj-ffff",
				}),
			).rejects.toBeInstanceOf(PlotAttachmentNotFoundError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("detaches the first match when multiple attachments share a ref", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-detach-dup-"));
		try {
			const plotId = await seedPlot(dir);
			const a = await defaultPlotAttacher.attach({
				plotDir: dir,
				plotId,
				handle: "alice",
				kind: "seeds_issue",
				ref: "proj-dead",
				role: "tracks",
			});
			const b = await defaultPlotAttacher.attach({
				plotDir: dir,
				plotId,
				handle: "alice",
				kind: "seeds_issue",
				ref: "proj-dead",
				role: "informs",
			});
			expect(a.attachment.id).not.toBe(b.attachment.id);

			const result = await defaultPlotAttacher.detach({
				plotDir: dir,
				plotId,
				handle: "alice",
				ref: "proj-dead",
			});
			expect(result.removed_id).toBe(a.attachment.id);
			expect(result.attachments).toHaveLength(1);
			expect(result.attachments[0]?.id).toBe(b.attachment.id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
