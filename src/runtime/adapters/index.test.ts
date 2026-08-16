import { describe, expect, test } from "bun:test";

import { KNOWN_RUNTIME_IDS } from "../../core/wire.ts";
import {
	adapterFor,
	allAdapters,
	harnessStatePrefixes,
	providerErrorEnvelopeTypes,
	RUNTIME_ADAPTERS,
} from "./index.ts";

describe("adapter registry (warren-c80e)", () => {
	test("declares exactly one adapter per known runtime id, keyed by its own id", () => {
		expect(Object.keys(RUNTIME_ADAPTERS).sort()).toEqual([...KNOWN_RUNTIME_IDS].sort());
		for (const id of KNOWN_RUNTIME_IDS) {
			// A copy-paste that leaves the wrong id on an adapter would make
			// `adapterFor` silently answer for another harness.
			expect(adapterFor(id).runtimeId).toBe(id);
		}
		expect(allAdapters()).toHaveLength(KNOWN_RUNTIME_IDS.length);
	});

	test("every declared prefix is directory-shaped", () => {
		// The consumers match with `startsWith`, so a prefix missing its
		// trailing slash would also swallow a sibling like `.claudeignore`.
		for (const adapter of allAdapters()) {
			for (const prefix of adapter.harnessStatePrefixes) {
				expect(prefix.endsWith("/")).toBe(true);
				expect(prefix.startsWith("/")).toBe(false);
			}
		}
	});
});

describe("what the seam must not lose (warren-c80e)", () => {
	test("the harness-state union still carries the pre-seam claude-code prefix", () => {
		// `HARNESS_STATE_PREFIXES` was the flat literal `[".claude/"]`. Whatever
		// else the registry gains, dropping this one would re-arm the
		// dropped-commit guard against claude-code's own scratch (warren-f6f2).
		expect(harnessStatePrefixes()).toContain(".claude/");
	});

	test("the provider-error union is exactly the pair the classifier hardcoded", () => {
		// warren-edc3 read `turn_end` and `agent_end` and nothing else. This
		// move is behavior-neutral only while the union stays that set, so a
		// future adapter adding a third type has to come here and say why.
		expect([...providerErrorEnvelopeTypes()].sort()).toEqual(["agent_end", "turn_end"]);
	});

	test("pi contributes its transcript dir but NOT the composition dirs above it", () => {
		// `.pi/skills/` and `.pi/prompts/` are written by warren from the agent
		// definition, not by the harness. Listing the bare `.pi/` parent would
		// make the dropped-commit guard ignore warren's own composition output.
		const pi = adapterFor("pi");
		expect(pi.harnessStatePrefixes).toEqual([".pi/sessions/"]);
		expect(pi.harnessStatePrefixes).not.toContain(".pi/");
	});

	test("a runtime with nothing to declare says so with an empty list", () => {
		// Empty is a claim backed by the per-adapter doc comment, never an
		// accidental hole: `undefined` would type-error at the interface.
		expect(adapterFor("claude-code").terminalErrorEnvelopeTypes).toEqual([]);
	});
});
