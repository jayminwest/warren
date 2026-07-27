import { describe, expect, test } from "bun:test";
import { classifyDbFailure, dbFailureMessage } from "./redact.ts";

describe("classifyDbFailure", () => {
	test("maps postgres credential rejections to auth_failed", () => {
		for (const text of [
			'password authentication failed for user "warren"',
			'no pg_hba.conf entry for host "10.4.2.9", user "warren", database "warren"',
			'role "warren" does not exist',
		]) {
			expect(classifyDbFailure(new Error(text))).toBe("auth_failed");
		}
	});

	test("maps missing-schema errors to migration_pending", () => {
		for (const text of [
			'relation "runs" does not exist',
			"SQLITE_ERROR: no such table: runs",
			'column "target_branch" does not exist',
		]) {
			expect(classifyDbFailure(new Error(text))).toBe("migration_pending");
		}
	});

	test("maps transport + torn-down-handle failures to unreachable", () => {
		for (const text of [
			"connect ECONNREFUSED 10.4.2.9:5432",
			"getaddrinfo ENOTFOUND db.internal",
			"Connection terminated unexpectedly",
			"Cannot use a closed database",
			"unable to open database file",
		]) {
			expect(classifyDbFailure(new Error(text))).toBe("unreachable");
		}
	});

	test("refuses to guess — anything unrecognized is unknown", () => {
		expect(classifyDbFailure(new Error("something went sideways"))).toBe("unknown");
		expect(classifyDbFailure("not an error at all")).toBe("unknown");
	});
});

describe("dbFailureMessage", () => {
	test("returns only the reason code — host, port and role never reach the wire", () => {
		const message = dbFailureMessage(
			"db_reachable",
			new Error("connect ECONNREFUSED 10.4.2.9:5432 (user warren, db warren)"),
		);
		expect(message).toBe("probe failed (reason=unreachable)");
		expect(message).not.toContain("10.4.2.9");
		expect(message).not.toContain("5432");
		expect(message).not.toContain("warren");
	});

	test("logs the raw driver text under the failing check's name", () => {
		const logged: { obj: object; msg?: string }[] = [];
		dbFailureMessage("preview_max_live", new Error("connect ECONNREFUSED 10.4.2.9:5432"), {
			warn: (obj, msg) => logged.push({ obj, ...(msg !== undefined ? { msg } : {}) }),
		});
		expect(logged).toHaveLength(1);
		expect(logged[0]?.obj).toMatchObject({
			event: "diagnostics.probe_failed",
			check: "preview_max_live",
			reason: "unreachable",
			err_message: "Error: connect ECONNREFUSED 10.4.2.9:5432",
		});
	});

	test("is a no-op logger away from working — no log seam, same message", () => {
		expect(dbFailureMessage("db_reachable", new Error("no such table: runs"))).toBe(
			"probe failed (reason=migration_pending)",
		);
	});
});
