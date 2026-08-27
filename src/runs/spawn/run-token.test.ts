import { describe, expect, test } from "bun:test";
import {
	createHmacRunTokenMinter,
	isRunCallbackRoute,
	isRunScopedToken,
	RUN_CALLBACK_ROUTE_PATTERNS,
	verifyRunScopedToken,
} from "./run-token.ts";

const SECRET = "tok_operator_secret";
const RUN_ID = "run_abc123def456";

describe("createHmacRunTokenMinter", () => {
	test("mints a self-describing run-scoped token", () => {
		const token = createHmacRunTokenMinter(SECRET).mint(RUN_ID);
		expect(isRunScopedToken(token)).toBe(true);
		expect(token.split(".")).toHaveLength(3);
		expect(token).not.toBe(SECRET);
	});

	test("verifies against the signing secret and recovers the run id", () => {
		const token = createHmacRunTokenMinter(SECRET).mint(RUN_ID);
		expect(verifyRunScopedToken(token, SECRET)).toBe(RUN_ID);
	});

	test("mints distinct tokens per run", () => {
		const minter = createHmacRunTokenMinter(SECRET);
		expect(minter.mint("run_aaaaaaaaaaaa")).not.toBe(minter.mint("run_bbbbbbbbbbbb"));
	});
});

describe("verifyRunScopedToken", () => {
	test("rejects a token signed with a different secret", () => {
		const token = createHmacRunTokenMinter(SECRET).mint(RUN_ID);
		expect(verifyRunScopedToken(token, "some_other_secret")).toBeNull();
	});

	test("rejects a token whose run id was tampered with (signature no longer matches)", () => {
		const token = createHmacRunTokenMinter(SECRET).mint(RUN_ID);
		const [, , sig] = token.split(".");
		const forged = `wrs1.run_evilevilevil.${sig}`;
		expect(verifyRunScopedToken(forged, SECRET)).toBeNull();
	});

	test("rejects a malformed token", () => {
		expect(verifyRunScopedToken("not-a-token", SECRET)).toBeNull();
		expect(verifyRunScopedToken("wrs1.run_x", SECRET)).toBeNull();
		expect(verifyRunScopedToken("wrs1..sig", SECRET)).toBeNull();
		expect(verifyRunScopedToken("other.run_x.sig", SECRET)).toBeNull();
	});

	test("does not treat the raw operator token as run-scoped", () => {
		expect(isRunScopedToken(SECRET)).toBe(false);
	});
});

describe("isRunCallbackRoute", () => {
	test("admits exactly the five run callback routes", () => {
		expect(isRunCallbackRoute("/runs/:id/inbox")).toBe(true);
		expect(isRunCallbackRoute("/runs/:id/finalize-intent")).toBe(true);
		expect(isRunCallbackRoute("/runs/:id/finalize-result")).toBe(true);
		// warren-7c1e: the salvage intake was missing here, so the pod's
		// last-resort work-recovery POST was 403'd by the run-scope gate.
		expect(isRunCallbackRoute("/runs/:id/salvage")).toBe(true);
		// warren-5a5c: the K8s App-mode credential remint — the pod's
		// finalize-entrypoint POSTs here with the run-scoped token, and the
		// gate 403'd it, so App-mode remint could never work.
		expect(isRunCallbackRoute("/runs/:id/git-credential")).toBe(true);
		expect(RUN_CALLBACK_ROUTE_PATTERNS.size).toBe(5);
	});

	test("refuses operator routes", () => {
		expect(isRunCallbackRoute("/runs")).toBe(false);
		expect(isRunCallbackRoute("/runs/:id/steer")).toBe(false);
		expect(isRunCallbackRoute("/projects/:id")).toBe(false);
		expect(isRunCallbackRoute("/analytics/cost")).toBe(false);
	});
});
