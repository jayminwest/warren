import { describe, expect, test } from "bun:test";
import pino from "pino";
import { LOG_REDACT_OPTIONS, LOG_REDACT_PATHS } from "./redact.ts";

/** Capture pino's JSON output by pointing it at an in-memory sink. */
function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
	const chunks: string[] = [];
	const logger = pino(
		{ redact: LOG_REDACT_OPTIONS },
		{
			write(chunk: string) {
				chunks.push(chunk);
			},
		},
	);
	return {
		logger,
		lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
	};
}

describe("LOG_REDACT_PATHS", () => {
	test("covers token-shaped fields at top level and one level deep", () => {
		expect(LOG_REDACT_PATHS).toContain("token");
		expect(LOG_REDACT_PATHS).toContain("GITHUB_TOKEN");
		expect(LOG_REDACT_PATHS).toContain("*.token");
		expect(LOG_REDACT_PATHS).toContain("headers.authorization");
	});
});

describe("LOG_REDACT_OPTIONS applied to pino", () => {
	test("censors a top-level token field", () => {
		const { logger, lines } = captureLogger();
		logger.info({ token: "ghp_secretvalue", runId: "run_1" }, "boot");
		const [line] = lines();
		expect(line?.token).toBe("[Redacted]");
		expect(line?.runId).toBe("run_1");
	});

	test("censors a nested GITHUB_TOKEN and bearer header", () => {
		const { logger, lines } = captureLogger();
		logger.info(
			{ config: { GITHUB_TOKEN: "ghp_x" }, headers: { authorization: "Bearer abc" } },
			"req",
		);
		const [line] = lines();
		const config = line?.config as Record<string, unknown>;
		const headers = line?.headers as Record<string, unknown>;
		expect(config.GITHUB_TOKEN).toBe("[Redacted]");
		expect(headers.authorization).toBe("[Redacted]");
	});

	test("leaves non-secret fields untouched", () => {
		const { logger, lines } = captureLogger();
		logger.info({ url: "https://example.com", count: 7 }, "ok");
		const [line] = lines();
		expect(line?.url).toBe("https://example.com");
		expect(line?.count).toBe(7);
	});
});
