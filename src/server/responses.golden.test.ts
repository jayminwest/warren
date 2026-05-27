/**
 * Golden snapshot tests for stable HTTP response envelopes (warren-8aa4 /
 * pl-7b06 step 22).
 *
 * Each case below is a (name, producer) tuple where the producer runs
 * the live `errors.ts` machinery for one canonical input. The expected
 * `{ status, body }` lives on disk under `__golden__/responses/<name>.json`;
 * the test deep-equals the live output against the file.
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/responses.golden.test.ts` — the test will rewrite every
 * fixture to match the current producer. Inspect `git diff` and commit
 * only the changes you actually intended; a noisy churn means the
 * producer was destabilised (and should be reverted) rather than the
 * goldens needing a refresh.
 *
 * Mirrors burrow's parser `__golden__/` convention (`burrow/src/runtime/
 * parsers/__golden__/`). Keep new golden directories named `__golden__/`
 * so the existing exclusions in `scripts/check-file-sizes.ts`,
 * `scripts/check-debt-markers.ts`, `.jscpd.json`, and `biome.json` keep
 * applying.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	NotFoundError as BurrowNotFoundError,
	ValidationError as BurrowValidationError,
} from "@os-eco/burrow-cli";
import { BurrowUnreachableError } from "../burrow-client/errors.ts";
import { NotFoundError, StateTransitionError, ValidationError } from "../core/errors.ts";
import { CanopyUnavailableError } from "../registry/errors.ts";
import {
	methodNotAllowed,
	notFound,
	notImplemented,
	type RenderedError,
	renderError,
} from "./errors.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

interface Snapshot {
	readonly status: number;
	readonly body: unknown;
}

function snapshot(r: RenderedError): Snapshot {
	return { status: r.status, body: r.envelope };
}

const cases: ReadonlyArray<{ name: string; produce: () => Snapshot }> = [
	{
		name: "canned-not-found",
		produce: () => snapshot(notFound("/some/missing/path")),
	},
	{
		name: "canned-method-not-allowed",
		produce: () => snapshot(methodNotAllowed("PATCH", "/runs/abc")),
	},
	{
		name: "canned-not-implemented",
		produce: () => snapshot(notImplemented("GET /scaffold")),
	},
	{
		name: "warren-not-found",
		produce: () => snapshot(renderError(new NotFoundError("run abc not found"))),
	},
	{
		name: "warren-validation",
		produce: () => snapshot(renderError(new ValidationError("bad field 'name'"))),
	},
	{
		name: "warren-validation-with-hint",
		produce: () =>
			snapshot(
				renderError(new ValidationError("bad field 'name'", { recoveryHint: "use kebab-case" })),
			),
	},
	{
		name: "warren-state-transition",
		produce: () => snapshot(renderError(new StateTransitionError("cannot cancel finished run"))),
	},
	{
		name: "warren-burrow-unreachable",
		produce: () => snapshot(renderError(new BurrowUnreachableError("socket closed"))),
	},
	{
		name: "warren-canopy-unavailable",
		produce: () => snapshot(renderError(new CanopyUnavailableError("CANOPY_REPO_URL unset"))),
	},
	{
		name: "burrow-not-found-passthrough",
		produce: () =>
			snapshot(renderError(new BurrowNotFoundError("agent claude-code not installed"))),
	},
	{
		name: "burrow-validation-passthrough",
		produce: () => snapshot(renderError(new BurrowValidationError("bad body"))),
	},
	{
		name: "internal-error-from-error",
		produce: () => snapshot(renderError(new Error("boom"))),
	},
	{
		name: "internal-error-from-non-error",
		produce: () => snapshot(renderError("string thrown")),
	},
];

describe("response envelopes — __golden__ snapshots", () => {
	if (UPDATE) {
		// Single regen "test" — Bun emits one PASS line so it's obvious in
		// CI logs when goldens were rewritten (and the bare `bun test` run
		// that follows will diff the committed fixtures against the live
		// producer).
		test("regenerate fixtures", () => {
			if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
			for (const c of cases) {
				const path = join(GOLDEN_DIR, `${c.name}.json`);
				const formatted = `${JSON.stringify(c.produce(), null, "\t")}\n`;
				writeFileSync(path, formatted);
			}
			expect(cases.length).toBeGreaterThan(0);
		});
		return;
	}

	for (const c of cases) {
		test(c.name, () => {
			const path = join(GOLDEN_DIR, `${c.name}.json`);
			const expected = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
			expect(c.produce()).toEqual(expected);
		});
	}
});
