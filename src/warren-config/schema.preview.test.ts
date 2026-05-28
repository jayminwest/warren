import { describe, expect, test } from "bun:test";
import { VALID_SERVER_PREVIEW } from "./schema.test-helpers.ts";
import {
	DEFAULT_PREVIEW_MODE,
	PreviewConfigSchema,
	PreviewModeSchema,
	parsePreviewFile,
} from "./schema.ts";

describe("PreviewConfigSchema", () => {
	test("accepts the full server-type shape from SPEC §11.L", () => {
		const parsed = PreviewConfigSchema.safeParse(VALID_SERVER_PREVIEW);
		expect(parsed.success).toBe(true);
	});

	test("accepts the minimum server shape (command + port only)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts type: 'static' at the parser level (launcher rejects later — warren-f156)", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "static" });
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown type discriminators", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "lambda",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects missing command for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", port: 3000 });
		expect(parsed.success).toBe(false);
	});

	test("rejects missing port for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", command: "bun run dev" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty command", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			command: "",
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects non-integer / out-of-range ports", () => {
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 0 }).success).toBe(false);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 70000 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 3.14 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: "3000" }).success).toBe(
			false,
		);
	});

	test("accepts privileged ports (1-1023) — sandbox runs unprivileged-by-namespace", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 80 });
		expect(parsed.success).toBe(true);
	});

	test("rejects readiness_path that doesn't start with '/'", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			readiness_path: "healthz",
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts duration strings: 30m, 8h, 45s, 1d, 200ms, 1h30m", () => {
		for (const d of ["30m", "8h", "45s", "1d", "200ms", "1h30m"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
				max_lifetime: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects garbage duration strings", () => {
		for (const d of ["thirty minutes", "30", "m30", "30y", ""]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-0928: readiness_timeout is shape-validated like idle_ttl but
	// additionally bounded 1s..1h so pathological config (sub-poll polls,
	// >1h ceilings) surfaces at load time rather than reap time.
	test("accepts readiness_timeout within 1s..1h", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects readiness_timeout under 1s", () => {
		for (const d of ["500ms", "999ms"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects readiness_timeout over 1h", () => {
		for (const d of ["2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-d9e7: setup splits dependency-install from dev-server bind so each
	// phase has its own timeout and failure reason. Schema accepts the field at
	// the parser layer; launcher (src/preview/launch.ts) skips the pre-step
	// when the field is absent so existing projects keep working unchanged.
	test("accepts a server preview with setup + setup_timeout (warren-d9e7)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "pnpm install",
			setup_timeout: "5m",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.setup).toBe("pnpm install");
			expect(parsed.data.setup_timeout).toBe("5m");
		}
	});

	test("accepts setup without setup_timeout (launcher uses default)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "pnpm install",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects empty setup string", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "",
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts setup_timeout within 1s..1h", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects setup_timeout outside 1s..1h", () => {
		for (const d of ["500ms", "999ms", "2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-9b15: connect_timeout splits "did anything bind?" from
	// readiness_timeout's "did the bound server return 2xx?". Same 1s..1h
	// bounds and shape-validation pattern as the sibling timeouts.
	test("accepts connect_timeout within 1s..1h (warren-9b15)", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				connect_timeout: d,
			});
			expect(parsed.success).toBe(true);
			if (parsed.success && parsed.data.type === "server") {
				expect(parsed.data.connect_timeout).toBe(d);
			}
		}
	});

	test("rejects connect_timeout outside 1s..1h", () => {
		for (const d of ["500ms", "999ms", "2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				connect_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects garbage setup_timeout duration strings", () => {
		for (const d of ["five minutes", "30", "m30", "30y", ""]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects strict-extra fields on server preview so typos surface loudly", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			ttl: "30m", // common typo: design lock rejected single-TTL collapse
		});
		expect(parsed.success).toBe(false);
	});

	test("keeps idle_ttl and max_lifetime as separate fields (design lock — no single-ttl collapse)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
			idle_ttl: "30m",
			max_lifetime: "8h",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.idle_ttl).toBe("30m");
			expect(parsed.data.max_lifetime).toBe("8h");
		}
	});
});

describe("PreviewConfigSchema preview mode", () => {
	test("DEFAULT_PREVIEW_MODE is 'path' (zero-domain operators win by default)", () => {
		expect(DEFAULT_PREVIEW_MODE).toBe("path");
	});

	test("PreviewModeSchema accepts 'path' and 'subdomain'", () => {
		expect(PreviewModeSchema.safeParse("path").success).toBe(true);
		expect(PreviewModeSchema.safeParse("subdomain").success).toBe(true);
	});

	test("PreviewModeSchema rejects unknown values (no silent typos)", () => {
		expect(PreviewModeSchema.safeParse("PATH").success).toBe(false);
		expect(PreviewModeSchema.safeParse("subDomain").success).toBe(false);
		expect(PreviewModeSchema.safeParse("").success).toBe(false);
		expect(PreviewModeSchema.safeParse(null).success).toBe(false);
	});

	test("accepts server preview with mode: 'path'", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "path" });
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.mode).toBe("path");
		}
	});

	test("accepts server preview with mode: 'subdomain'", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "subdomain" });
		expect(parsed.success).toBe(true);
	});

	test("accepts server preview without mode (operator env decides)", () => {
		const parsed = PreviewConfigSchema.safeParse(VALID_SERVER_PREVIEW);
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.mode).toBeUndefined();
		}
	});

	test("rejects unknown mode values on server preview", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "lambda" });
		expect(parsed.success).toBe(false);
	});

	test("accepts static preview with mode (passthrough stays permissive)", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "static", mode: "subdomain" });
		expect(parsed.success).toBe(true);
	});

	test("parsePreviewFile threads mode into the parsed value", () => {
		const result = parsePreviewFile({ ...VALID_SERVER_PREVIEW, mode: "subdomain" });
		expect(result.ok).toBe(true);
		if (result.ok && result.value !== null && result.value.type === "server") {
			expect(result.value.mode).toBe("subdomain");
		}
	});

	test("parsePreviewFile surfaces unknown mode values via the error envelope", () => {
		const result = parsePreviewFile({ ...VALID_SERVER_PREVIEW, mode: "weird" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/mode/);
		}
	});
});
