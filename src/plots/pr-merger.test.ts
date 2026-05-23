/**
 * Unit tests for `defaultPlotPrMerger` (warren-8e39 / pl-0344 step 14).
 *
 * Exercises the production attach + merge path against a real
 * `@os-eco/plot-cli` `.plot/` fixture, with `fetch` injected as a stub
 * so we don't hit real GitHub.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserPlotClient } from "../plot-client/index.ts";
import {
	PlotAttachmentNotFoundError,
	PlotPrAttachmentInvalidError,
	PlotPrAttachmentMismatchedKindError,
} from "./errors.ts";
import { defaultPlotPrMerger } from "./pr-merger.ts";

async function seedPlot(dir: string): Promise<string> {
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	const seeded = await client.create({ name: "T" });
	client.close();
	return seeded.id;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(responses: ReadonlyArray<Response>): {
	fetch: typeof fetch;
	calls: { url: string; method: string }[];
} {
	const calls: { url: string; method: string }[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		const next = responses[i++];
		if (next === undefined) throw new Error("stubFetch: out of canned responses");
		return next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

async function attachPr(plotDir: string, plotId: string, ref: string): Promise<string> {
	const client = new UserPlotClient({
		dir: plotDir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	try {
		const att = await client.get(plotId).attach({ type: "gh_pr", ref, role: "tracks" });
		return att.id;
	} finally {
		client.close();
	}
}

describe("defaultPlotPrMerger.merge", () => {
	test("merges a gh_pr attachment with owner/repo#N ref", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-prmerge-"));
		try {
			const plotId = await seedPlot(dir);
			await attachPr(dir, plotId, "o/r#7");
			const { fetch, calls } = stubFetch([jsonResponse(200, { merged: true, sha: "deadbeef" })]);
			const result = await defaultPlotPrMerger.merge({
				plotDir: dir,
				plotId,
				handle: "alice",
				ref: "o/r#7",
				token: "ghp_x",
				fetch,
			});
			expect(result.merge.kind).toBe("merged");
			expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
			expect(calls[0]?.method).toBe("PUT");
			expect(result.attachments).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("surfaces missing_token when token is empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-prmerge-token-"));
		try {
			const plotId = await seedPlot(dir);
			await attachPr(dir, plotId, "o/r#1");
			const result = await defaultPlotPrMerger.merge({
				plotDir: dir,
				plotId,
				handle: "alice",
				ref: "o/r#1",
				token: "",
			});
			expect(result.merge.kind).toBe("missing_token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects when ref is not on the Plot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-prmerge-missing-"));
		try {
			const plotId = await seedPlot(dir);
			await expect(
				defaultPlotPrMerger.merge({
					plotDir: dir,
					plotId,
					handle: "alice",
					ref: "o/r#404",
					token: "ghp_x",
				}),
			).rejects.toBeInstanceOf(PlotAttachmentNotFoundError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects when attachment is not gh_pr kind", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-prmerge-wrongkind-"));
		try {
			const plotId = await seedPlot(dir);
			const client = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			try {
				await client.get(plotId).attach({ type: "seeds_issue", ref: "proj-abcd", role: "tracks" });
			} finally {
				client.close();
			}
			await expect(
				defaultPlotPrMerger.merge({
					plotDir: dir,
					plotId,
					handle: "alice",
					ref: "proj-abcd",
					token: "ghp_x",
				}),
			).rejects.toBeInstanceOf(PlotPrAttachmentMismatchedKindError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects when gh_pr ref is not a recognized shape", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-prmerge-badref-"));
		try {
			const plotId = await seedPlot(dir);
			await attachPr(dir, plotId, "not a url");
			await expect(
				defaultPlotPrMerger.merge({
					plotDir: dir,
					plotId,
					handle: "alice",
					ref: "not a url",
					token: "ghp_x",
				}),
			).rejects.toBeInstanceOf(PlotPrAttachmentInvalidError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
