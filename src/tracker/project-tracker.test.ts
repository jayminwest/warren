import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import type { IssueTracker } from "./contract.ts";
import { ProjectTracker } from "./project-tracker.ts";

const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fallback: IssueTracker = {
	capabilities: {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: true,
	},
	getIssue: async (_ctx, id) => ({ id, status: "open" }),
	listIssueStatuses: async () => new Map(),
	closeIssue: async () => {},
};
function directory() {
	const path = mkdtempSync(join(tmpdir(), "project-tracker-"));
	dirs.push(path);
	mkdirSync(join(path, ".warren"));
	return path;
}
function remote(id: string) {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			if (new URL(request.url).pathname === "/capabilities")
				return Response.json({
					protocolVersion: "warren-tracker/v1",
					capabilities: {
						supportsPlans: false,
						supportsMetadata: false,
						supportsScheduledIssues: false,
						isGitNative: false,
						supportsIssueListing: true,
					},
				});
			return Response.json({ id, status: "open", ready: true });
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function allowRemote(env: Record<string, string>, id: string): string {
	const url = remote(id);
	const allowed = JSON.parse(env.WARREN_TRACKER_ALLOWED_URLS ?? "[]") as string[];
	env.WARREN_TRACKER_ALLOWED_URLS = JSON.stringify([...allowed, url]);
	return url;
}
describe("ProjectTracker", () => {
	test("routes each project independently, refreshes a changed config, and keeps Seeds as fallback", async () => {
		const path = directory();
		const other = directory();
		const cache = createWarrenConfigCache();
		const env: Record<string, string> = {
			WARREN_TRACKER_ALLOWED_URLS: "[]",
			WARREN_TRACKER_ALLOWED_TOKEN_ENVS: '["MISSING_SECRET"]',
		};
		const tracker = new ProjectTracker(cache, env, fallback);
		const ctx = { projectId: "one", localPath: path };
		expect(await tracker.resolveForProject(ctx)).toBe(fallback);
		writeFileSync(
			join(path, ".warren/config.yaml"),
			`tracker:\n  url: ${allowRemote(env, "remote-one")}\n`,
		);
		cache.invalidate("one");
		expect((await tracker.getIssue(ctx, "remote-one")).id).toBe("remote-one");
		expect((await tracker.resolveForProject(ctx)).capabilities.supportsIssueListing).toBe(true);
		expect(await tracker.resolveForProject({ projectId: "two", localPath: other })).toBe(fallback);
		writeFileSync(
			join(path, ".warren/config.yaml"),
			`tracker:\n  url: ${allowRemote(env, "remote-two")}\n`,
		);
		cache.invalidate("one");
		expect((await tracker.getIssue(ctx, "remote-two")).id).toBe("remote-two");
	});

	test("does not fall back when configured credentials are missing or config is malformed", async () => {
		const path = directory();
		const cache = createWarrenConfigCache();
		const env: Record<string, string> = {
			WARREN_TRACKER_ALLOWED_URLS: "[]",
			WARREN_TRACKER_ALLOWED_TOKEN_ENVS: '["MISSING_SECRET"]',
		};
		const tracker = new ProjectTracker(cache, env, fallback);
		const ctx = { projectId: "one", localPath: path };
		writeFileSync(
			join(path, ".warren/config.yaml"),
			`tracker:\n  url: ${allowRemote(env, "remote-one")}\n  tokenEnv: MISSING_SECRET\n`,
		);
		await expect(tracker.resolveForProject(ctx)).rejects.toThrow("MISSING_SECRET");
		writeFileSync(join(path, ".warren/config.yaml"), "tracker: [broken\n");
		cache.invalidate("one");
		await expect(tracker.resolveForProject(ctx)).rejects.toThrow("configuration is invalid");
	});
});
