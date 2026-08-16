/**
 * Golden RPC-handshake compatibility lock for pi v0.74.0
 * (burrow-988b, plan pl-5198 step 7).
 *
 * Why: pi is pre-1.0. A silent reshape of the JSONL stream across a
 * minor bump would slip through the parser-layer unit tests, which
 * map envelope-by-envelope but never compare the full trace as a
 * whole. This test canonicalizes the volatile-field list documented
 * in src/runtime/parsers/__golden__/README.md (timestamp, responseId,
 * request_id, thinkingSignature, toolCallId — plus the `id` field
 * inside `type:"toolCall"` content blocks, which carries the same
 * toolCallId value) and compares the resulting canonical JSONL to a
 * checked-in golden. Renamed keys, new fields, or restructured
 * envelopes show up as a reviewable diff — that's the cue to update
 * the parser, the goldens, and the pinned pi version in
 * .devcontainer/Dockerfile in a single coordinated change.
 *
 * Regenerating the golden when pi changes intentionally:
 *
 *   1. Regenerate the input fixture per the procedure in
 *      src/runtime/parsers/__golden__/README.md.
 *   2. Re-run with the update flag:
 *
 *        WARREN_UPDATE_PI_GOLDEN=1 \
 *          bun test src/runtime/parsers/pi-handshake.test.ts
 *
 *      This rewrites the canonical goldens with the current fixture.
 *   3. Review the diff; bump the pinned pi version in
 *      .devcontainer/Dockerfile and the parser in lockstep.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeExtensionUiDecline } from "../pi-stdin.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__");
const UPDATE_GOLDEN = process.env.WARREN_UPDATE_PI_GOLDEN === "1";

const VOLATILE_PLACEHOLDERS: Readonly<Record<string, unknown>> = {
	timestamp: 0,
	responseId: "<responseId>",
	request_id: "<request_id>",
	thinkingSignature: "<thinkingSignature>",
	toolCallId: "<toolCallId>",
};

// The `id` field is contextual: a toolCall content block reuses the
// volatile toolCallId, and an extension_ui_request carries its own
// per-run correlation UUID. Both are scrubbed to a stable placeholder so
// the canonical golden locks structure, not random ids.
function idPlaceholderFor(type: unknown): string | undefined {
	if (type === "toolCall") return "<toolCallId>";
	if (type === "extension_ui_request") return "<uiRequestId>";
	return undefined;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	const idPlaceholder = idPlaceholderFor(obj.type);
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj).sort()) {
		if (k in VOLATILE_PLACEHOLDERS) {
			out[k] = VOLATILE_PLACEHOLDERS[k];
		} else if (k === "id" && idPlaceholder !== undefined) {
			out[k] = idPlaceholder;
		} else {
			out[k] = canonicalize(obj[k]);
		}
	}
	return out;
}

function canonicalizeJsonl(raw: string): string {
	const lines = raw.split("\n").filter((l) => l.length > 0);
	const canonical = lines.map((l) => JSON.stringify(canonicalize(JSON.parse(l))));
	return `${canonical.join("\n")}\n`;
}

const FIXTURES = [
	"pi-v0.74.0-anthropic-success",
	"pi-v0.74.0-anthropic-tools",
	"pi-v0.78.1-anthropic-success",
	"pi-v0.78.1-anthropic-tools",
	"pi-v0.78.1-anthropic-extension-ui",
] as const;

describe("pi RPC handshake (golden wire-shape lock)", () => {
	for (const name of FIXTURES) {
		describe(name, () => {
			const fixturePath = join(GOLDEN_DIR, `${name}.jsonl`);
			const goldenPath = join(GOLDEN_DIR, `${name}.canonical.jsonl`);
			const fixture = readFileSync(fixturePath, "utf8");

			test("canonicalized fixture matches the checked-in golden", () => {
				const actual = canonicalizeJsonl(fixture);
				if (UPDATE_GOLDEN) writeFileSync(goldenPath, actual);
				const expected = readFileSync(goldenPath, "utf8");
				expect(actual).toBe(expected);
			});

			test("fixture is LF-terminated JSONL with one JSON object per non-empty line", () => {
				expect(fixture.endsWith("\n")).toBe(true);
				const lines = fixture.split("\n");
				expect(lines[lines.length - 1]).toBe("");
				for (const line of lines.slice(0, -1)) {
					expect(line.length).toBeGreaterThan(0);
					const obj = JSON.parse(line) as unknown;
					expect(typeof obj).toBe("object");
					expect(obj).not.toBeNull();
					expect(Array.isArray(obj)).toBe(false);
				}
			});

			test("first envelope is the RPC ack: {type:'response',command:'prompt',success:true}", () => {
				const firstLine = fixture.split("\n")[0] ?? "";
				const obj = JSON.parse(firstLine) as Record<string, unknown>;
				expect(obj.type).toBe("response");
				expect(obj.command).toBe("prompt");
				expect(obj.success).toBe(true);
			});

			test("last envelope is agent_end (end-of-run marker)", () => {
				const lines = fixture.split("\n").filter((l) => l.length > 0);
				const last = lines[lines.length - 1] ?? "";
				const obj = JSON.parse(last) as Record<string, unknown>;
				expect(obj.type).toBe("agent_end");
			});
		});
	}

	test("canonicalization scrubs every documented volatile field across all fixtures", () => {
		const volatileKeys = new Set(Object.keys(VOLATILE_PLACEHOLDERS));
		for (const name of FIXTURES) {
			const raw = readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), "utf8");
			const canonical = canonicalizeJsonl(raw);
			for (const line of canonical.split("\n").filter((l) => l.length > 0)) {
				const obj = JSON.parse(line) as unknown;
				assertScrubbed(obj, volatileKeys);
			}
		}
	});

	describe("pi-v0.78.1-anthropic-extension-ui (extensions enabled)", () => {
		const raw = readFileSync(join(GOLDEN_DIR, "pi-v0.78.1-anthropic-extension-ui.jsonl"), "utf8");
		const envelopes = raw
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);

		test("carries exactly one extension_ui_request with the 0.78.1 select shape", () => {
			const requests = envelopes.filter((e) => e.type === "extension_ui_request");
			expect(requests).toHaveLength(1);
			const req = requests[0] as Record<string, unknown>;
			expect(req.method).toBe("select");
			expect(typeof req.id).toBe("string");
			expect((req.id as string).length).toBeGreaterThan(0);
			expect(typeof req.title).toBe("string");
			expect(Array.isArray(req.options)).toBe(true);
		});

		test("auto-answer declines the real request by correlated id with cancelled:true", () => {
			const req = envelopes.find((e) => e.type === "extension_ui_request");
			expect(req).toBeDefined();
			const reply = JSON.parse(encodeExtensionUiDecline(req)) as Record<string, unknown>;
			expect(reply).toEqual({
				type: "extension_ui_response",
				id: req?.id,
				cancelled: true,
			});
		});

		test("declined extension_ui_request does not abort the run (agent_end still arrives)", () => {
			expect(envelopes[envelopes.length - 1]?.type).toBe("agent_end");
		});
	});

	describe("0.78.1 vocabulary deltas vs 0.74.0", () => {
		function lastEnvelope(name: string): Record<string, unknown> {
			const lines = readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), "utf8")
				.split("\n")
				.filter((l) => l.length > 0);
			return JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
		}

		test("0.78.1 agent_end gains a willRetry field (absent in 0.74.0)", () => {
			const v74 = lastEnvelope("pi-v0.74.0-anthropic-tools");
			const v78 = lastEnvelope("pi-v0.78.1-anthropic-tools");
			expect(v74.type).toBe("agent_end");
			expect(v78.type).toBe("agent_end");
			expect("willRetry" in v74).toBe(false);
			expect("willRetry" in v78).toBe(true);
			expect(typeof v78.willRetry).toBe("boolean");
		});
	});
});

function assertScrubbed(value: unknown, volatileKeys: ReadonlySet<string>): void {
	if (Array.isArray(value)) {
		for (const v of value) assertScrubbed(v, volatileKeys);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const obj = value as Record<string, unknown>;
	for (const [k, v] of Object.entries(obj)) {
		if (volatileKeys.has(k)) {
			expect(v).toEqual(VOLATILE_PLACEHOLDERS[k]);
		}
		if (k === "id" && obj.type === "toolCall") {
			expect(v).toBe("<toolCallId>");
		}
		if (k === "id" && obj.type === "extension_ui_request") {
			expect(v).toBe("<uiRequestId>");
		}
		assertScrubbed(v, volatileKeys);
	}
}
