/**
 * SeedsTracker parity subset (warren-53ea, plan pl-a37b Track B).
 *
 * The published conformance suite (extensions/tracker-conformance/)
 * proves a warren-tracker/v1 SERVER over HTTP. This file runs the
 * suite's SEMANTIC assertions — the cases that are about contract
 * behavior, not wire shape — against SeedsTracker, implementation #1,
 * so both implementations provably agree on the base-contract
 * semantics the suite names:
 *
 *   - `issues/close-idempotent`   — closing an already-closed issue is
 *     a success, never an error.
 *   - `errors/*-not-found`        — a missing id surfaces as
 *     IssueNotFoundError on both the read and the close path, never as
 *     a generic TrackerError.
 *   - `issues/status-normalization` — the tracker's RAW statuses fold
 *     onto warren's three-state vocabulary (open/closed/other) exactly
 *     the way the RemoteTracker bridge normalizes a remote server's raw
 *     strings.
 *   - `issues/close-status-consistency` — after a close, the single
 *     issue read and the id → status map agree.
 *
 * If a case here ever needs to diverge from the suite's semantics, the
 * CONTRACT changed — change the suite (and the protocol doc) in the
 * same commit, not just this file.
 */

import { describe, expect, test } from "bun:test";

import { IssueNotFoundError, type TrackerContext, TrackerError } from "../core/wire-tracker.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { SeedsTracker } from "./seeds-tracker.ts";

const CTX: TrackerContext = { projectId: "proj-1", localPath: "/data/projects/x/y" };

/**
 * A stateful fake `sd`: the minimum seeds CLI surface SeedsTracker
 * exercises (`show --json`, `list --format json`, `close`), backed by
 * an in-memory id → status map with real seeds semantics — close is
 * idempotent, unknown ids exit 1 with the not-found spelling.
 */
function fakeSd(initial: Readonly<Record<string, string>>): SpawnFn {
	const statuses = new Map(Object.entries(initial));
	return async (cmd) => {
		const [, sub, a1] = cmd;
		if (sub === "show") {
			const id = a1 as string;
			const status = statuses.get(id);
			if (status === undefined) {
				return { stdout: "", stderr: `seeds: Issue not found: ${id}`, exitCode: 1 };
			}
			return {
				stdout: JSON.stringify({ success: true, issue: { id, status } }),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "list") {
			return {
				stdout: JSON.stringify({
					success: true,
					issues: [...statuses.entries()].map(([id, status]) => ({ id, status })),
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "close") {
			const id = a1 as string;
			if (!statuses.has(id)) {
				return { stdout: "", stderr: `seeds: Issue not found: ${id}`, exitCode: 1 };
			}
			statuses.set(id, "closed");
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected sd invocation: ${cmd.join(" ")}`, exitCode: 2 };
	};
}

function tracker(spawn: SpawnFn): SeedsTracker {
	return new SeedsTracker({ spawn, sdBinary: "sd" });
}

describe("SeedsTracker conformance parity (suite semantic subset)", () => {
	test("issues/close-idempotent: closing twice succeeds; close flips the status", async () => {
		const t = tracker(fakeSd({ "warren-a": "open" }));
		await t.closeIssue(CTX, "warren-a");
		expect((await t.getIssue(CTX, "warren-a")).status).toBe("closed");
		// The contract: an already-closed close is a success, not an error.
		await t.closeIssue(CTX, "warren-a");
		expect((await t.getIssue(CTX, "warren-a")).status).toBe("closed");
	});

	test("errors/issue-read-not-found: a missing id throws IssueNotFoundError, not TrackerError", async () => {
		const t = tracker(fakeSd({}));
		let caught: unknown;
		try {
			await t.getIssue(CTX, "warren-missing");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(IssueNotFoundError);
	});

	test("errors/issue-close-not-found: closing a missing id throws IssueNotFoundError", async () => {
		const t = tracker(fakeSd({}));
		let caught: unknown;
		try {
			await t.closeIssue(CTX, "warren-missing");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(IssueNotFoundError);
		// Belt + braces: the taxonomy must not collapse to the generic case.
		expect(Object.getPrototypeOf(caught).constructor).not.toBe(TrackerError);
	});

	test("issues/status-normalization: raw statuses fold onto open/closed/other", async () => {
		const t = tracker(
			fakeSd({ "warren-open": "open", "warren-wip": "in_progress", "warren-done": "closed" }),
		);
		expect((await t.getIssue(CTX, "warren-open")).status).toBe("open");
		expect((await t.getIssue(CTX, "warren-wip")).status).toBe("other");
		expect((await t.getIssue(CTX, "warren-done")).status).toBe("closed");
	});

	test("issues/close-status-consistency: the issue read and the status map agree after close", async () => {
		const t = tracker(fakeSd({ "warren-a": "open", "warren-b": "open" }));
		await t.closeIssue(CTX, "warren-a");
		const issue = await t.getIssue(CTX, "warren-a");
		const statuses = await t.listIssueStatuses(CTX);
		expect(statuses.get("warren-a")).toBe(issue.status);
		expect(statuses.get("warren-b")).toBe("open");
	});
});
