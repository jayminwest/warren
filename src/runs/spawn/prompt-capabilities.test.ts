import { describe, expect, test } from "bun:test";
import type { IssueTracker } from "../../tracker/contract.ts";
import { resolvePromptCapabilities } from "./prompt-capabilities.ts";

const GIT_NATIVE_TRACKER: IssueTracker = {
	capabilities: {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: true,
	},
	getIssue: async () => {
		throw new Error("unused");
	},
	listIssueStatuses: async () => new Map(),
	closeIssue: async () => {},
};

const HOST_TRACKER: IssueTracker = {
	...GIT_NATIVE_TRACKER,
	capabilities: { ...GIT_NATIVE_TRACKER.capabilities, isGitNative: false },
};

describe("resolvePromptCapabilities", () => {
	test("capability-less project: no tracker, no mulch", () => {
		const caps = resolvePromptCapabilities({
			hasSeeds: false,
			localPath: "/data/projects/x/y",
			tracker: GIT_NATIVE_TRACKER,
			exists: () => false,
		});
		expect(caps).toEqual({ tracker: false, mulch: false });
	});

	test("seeds project with a git-native tracker: tracker text admitted", () => {
		const caps = resolvePromptCapabilities({
			hasSeeds: true,
			localPath: "/data/projects/x/y",
			tracker: GIT_NATIVE_TRACKER,
			exists: (p) => p === "/data/projects/x/y/.seeds",
		});
		expect(caps).toEqual({ tracker: true, mulch: false });
	});

	test("mulch present without seeds: expertise text admitted, tracker text not", () => {
		const caps = resolvePromptCapabilities({
			hasSeeds: false,
			localPath: "/data/projects/x/y",
			tracker: GIT_NATIVE_TRACKER,
			exists: (p) => p === "/data/projects/x/y/.mulch",
		});
		expect(caps).toEqual({ tracker: false, mulch: true });
	});

	test("a non-git-native tracker (host-backed) admits no .seeds/ assertions", () => {
		const caps = resolvePromptCapabilities({
			hasSeeds: true,
			localPath: "/data/projects/x/y",
			tracker: HOST_TRACKER,
			exists: () => true,
		});
		expect(caps.tracker).toBe(false);
	});

	test("no tracker wired (unwired tests) admits no tracker text even with .seeds/", () => {
		const caps = resolvePromptCapabilities({
			hasSeeds: true,
			localPath: "/data/projects/x/y",
			exists: () => true,
		});
		expect(caps.tracker).toBe(false);
	});
});
