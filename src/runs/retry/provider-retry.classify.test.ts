/**
 * The transient-vs-durable discriminator for a provider's terminal error
 * (warren-339d). Split out of `provider-retry.test.ts` because the pure
 * classifier and the post_reap subscriber share nothing but the module
 * they come from, and the combined file outgrew the size guard.
 *
 * Only network/upstream-class messages retry. Auth, model, quota,
 * rate-limit, and malformed-request rejections fail closed, as does
 * anything unrecognized.
 */

import { describe, expect, test } from "bun:test";
import { classifyProviderError } from "./provider-retry.ts";

describe("classifyProviderError", () => {
	test("classifies network-class messages as transient", () => {
		expect(classifyProviderError("Network connection lost.")).toBe("transient");
		expect(classifyProviderError("read ECONNRESET")).toBe("transient");
		expect(classifyProviderError("socket hang up")).toBe("transient");
		expect(classifyProviderError("fetch failed")).toBe("transient");
		expect(classifyProviderError("request timed out after 30s")).toBe("transient");
		expect(classifyProviderError("connect ETIMEDOUT 10.0.0.1:443")).toBe("transient");
		expect(classifyProviderError("Stream ended without finish_reason")).toBe("transient");
		expect(classifyProviderError("The operation was aborted")).toBe("transient");
		expect(classifyProviderError("Premature close")).toBe("transient");
	});

	test("classifies upstream 5xx / overload messages as transient", () => {
		expect(classifyProviderError("502 Bad Gateway")).toBe("transient");
		expect(classifyProviderError("503 Service Unavailable")).toBe("transient");
		expect(classifyProviderError("529 overloaded_error")).toBe("transient");
		expect(classifyProviderError("Internal server error")).toBe("transient");
	});

	test("classifies auth failures as durable", () => {
		expect(classifyProviderError("401 Unauthorized")).toBe("durable");
		expect(classifyProviderError("invalid x-api-key provided")).toBe("durable");
		expect(classifyProviderError("authentication_error: invalid api key")).toBe("durable");
		expect(classifyProviderError("403 Forbidden")).toBe("durable");
	});

	test("classifies model-not-found as durable", () => {
		expect(classifyProviderError("404 model 'kimi-k3' not found")).toBe("durable");
		expect(classifyProviderError("The model `gpt-x` does not exist")).toBe("durable");
		expect(classifyProviderError("not_found_error: model")).toBe("durable");
	});

	test("classifies quota / billing / rate-limit as durable", () => {
		expect(
			classifyProviderError("400 Your credit balance is too low to access the Anthropic API"),
		).toBe("durable");
		expect(classifyProviderError("402 payment required: quota exceeded")).toBe("durable");
		expect(classifyProviderError("429 rate limit exceeded")).toBe("durable");
		expect(classifyProviderError("Too many requests")).toBe("durable");
	});

	test("fails closed on unrecognized messages", () => {
		expect(classifyProviderError("")).toBe("unknown");
		expect(classifyProviderError("something weird happened")).toBe("unknown");
		expect(classifyProviderError("the agent exploded")).toBe("unknown");
	});

	test("reads the structured httpStatus before the prose fallback", () => {
		// 5xx short-circuits to transient even with no status token in the
		// prose (warren-f8b2).
		expect(classifyProviderError("the upstream gateway choked", 502)).toBe("transient");
		expect(classifyProviderError("something weird happened", 503)).toBe("transient");
		// 4xx short-circuits to durable even when the prose looks transient.
		expect(classifyProviderError("connection reset by peer", 401)).toBe("durable");
		expect(classifyProviderError("request failed", 429)).toBe("durable");
		// Null/undefined/out-of-range status falls back to the message parse.
		expect(classifyProviderError("something weird happened", null)).toBe("unknown");
		expect(classifyProviderError("Network connection lost.", undefined)).toBe("transient");
		expect(classifyProviderError("something weird happened", Number.NaN)).toBe("unknown");
		expect(classifyProviderError("something weird happened", 200)).toBe("unknown");
	});

	test("reads the structured upstreamBody before the message prose", () => {
		// Opaque harness message (pi's OPAQUE_MESSAGE) with a transient
		// upstream body retries (warren-eaa6).
		expect(classifyProviderError("Provider returned error", null, "529 overloaded_error")).toBe(
			"transient",
		);
		expect(classifyProviderError("Provider returned error", null, '{"error":"bad gateway"}')).toBe(
			"transient",
		);
		// A durable upstream body fails closed even though the surface
		// message is opaque.
		expect(classifyProviderError("Provider returned error", null, "invalid api key")).toBe(
			"durable",
		);
		// An unrecognized body falls through to the message prose.
		expect(classifyProviderError("Network connection lost.", null, "weird body")).toBe("transient");
		expect(classifyProviderError("something weird happened", null, "weird body")).toBe("unknown");
		// httpStatus still wins over the body tier.
		expect(classifyProviderError("Provider returned error", 401, "502 bad gateway")).toBe(
			"durable",
		);
	});

	test("durable wins when a message names both a symptom and a cause", () => {
		expect(classifyProviderError("request failed with 401: connection reset by peer")).toBe(
			"durable",
		);
	});
});
