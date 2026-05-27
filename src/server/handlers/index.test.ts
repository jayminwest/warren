import { describe, expect, test } from "bun:test";
import { isAuthExempt } from "./index.ts";

/* isAuthExempt tests (extracted from handlers.preview.test.ts, warren-599c / pl-9088 step 3). */

describe("isAuthExempt", () => {
	test("/healthz remains auth-exempt", () => {
		expect(isAuthExempt("/healthz")).toBe(true);
	});

	test("/version is auth-exempt (warren-6ea5)", () => {
		expect(isAuthExempt("/version")).toBe(true);
	});

	test("/runs/<id>/preview/login is auth-exempt (SPEC §11.L)", () => {
		expect(isAuthExempt("/runs/run_abc/preview/login")).toBe(true);
		expect(isAuthExempt("/runs/run_abc/preview/login/")).toBe(true);
	});

	test("other /runs/* surfaces remain gated", () => {
		expect(isAuthExempt("/runs")).toBe(false);
		expect(isAuthExempt("/runs/run_abc")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/events")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/extra")).toBe(false);
	});
});
