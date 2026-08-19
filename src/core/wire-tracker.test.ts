import { describe, expect, test } from "bun:test";
import { WarrenError } from "./errors.ts";
import {
	ISSUE_STATUSES,
	IssueNotFoundError,
	isIssueStatus,
	isPlanStatus,
	normalizeIssueStatus,
	PLAN_STATUSES,
	TrackerError,
} from "./wire-tracker.ts";

describe("wire-tracker", () => {
	test("isIssueStatus matches every ISSUE_STATUSES member and rejects others", () => {
		for (const status of ISSUE_STATUSES) {
			expect(isIssueStatus(status)).toBe(true);
		}
		expect(isIssueStatus("in_progress")).toBe(false);
		expect(isIssueStatus(42)).toBe(false);
		expect(isIssueStatus(undefined)).toBe(false);
	});

	test("normalizeIssueStatus passes open/closed through and folds the rest to other", () => {
		expect(normalizeIssueStatus("open")).toBe("open");
		expect(normalizeIssueStatus("closed")).toBe("closed");
		expect(normalizeIssueStatus("in_progress")).toBe("other");
		expect(normalizeIssueStatus("bogus")).toBe("other");
	});

	test("isPlanStatus matches every PLAN_STATUSES member and rejects others", () => {
		for (const status of PLAN_STATUSES) {
			expect(isPlanStatus(status)).toBe(true);
		}
		expect(isPlanStatus("archived")).toBe(false);
		expect(isPlanStatus(null)).toBe(false);
	});

	test("TrackerError is a WarrenError with the tracker_error code", () => {
		const err = new TrackerError("boom");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("tracker_error");
	});

	test("IssueNotFoundError subclasses TrackerError with its own code", () => {
		const err = new IssueNotFoundError("nope");
		expect(err).toBeInstanceOf(TrackerError);
		expect(err.code).toBe("issue_not_found");
	});
});
