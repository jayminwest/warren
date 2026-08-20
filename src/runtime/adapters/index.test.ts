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

	test("every declared prefix is directory-shaped or an exact filename (warren-8dc8)", () => {
		// The consumers match with `startsWith`. Entries fall into two valid shapes:
		//   1. Directory prefix (ends with '/') — the trailing slash prevents accidentally
		//      swallowing siblings (e.g. '.claude' without slash would also match '.claude.json').
		//   2. Exact filename (no slash, contains a dot extension) — precise enough that
		//      startsWith won't swallow unrelated siblings. Used when the harness writes a
		//      sibling file rather than a directory (warren-8dc8: '.claude.json' is a sibling
		//      of '.claude/', not inside it, so the directory prefix alone does not cover it).
		// A bare name with no extension and no trailing slash is the dangerous form and is rejected.
		for (const adapter of allAdapters()) {
			for (const prefix of adapter.harnessStatePrefixes) {
				expect(prefix.startsWith("/")).toBe(false);
				const isDirectory = prefix.endsWith("/");
				const isExactFile = prefix.includes(".");
				expect(isDirectory || isExactFile).toBe(true);
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
