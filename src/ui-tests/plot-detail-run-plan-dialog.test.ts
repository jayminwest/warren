/**
 * Structural UI test for the Plot Run-plan dialog
 * (warren-fdf0 / pl-f666 step 2).
 *
 * The warren UI package (src/ui) intentionally ships without a React
 * test harness (no jsdom, no @testing-library) — see project README.
 * Acceptance criteria for the editable-prompt change to
 * `RunPlanDialog` in `src/ui/src/pages/PlotDetail.tsx` are therefore
 * pinned at the source level: this file readFileSyncs the .tsx and
 * asserts the invariants from pl-f666 that a future regression
 * (e.g. someone reverting to a `ReadOnlyField` for the prompt, or
 * silently dropping the trimmed-non-empty validation) would visibly
 * break.
 *
 * Mirrors the structural-pinning posture used elsewhere in the repo
 * for surfaces without a runtime test seam.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLOT_DETAIL_PATH = join(import.meta.dir, "..", "ui", "src", "pages", "PlotDetail.tsx");
const SOURCE = readFileSync(PLOT_DETAIL_PATH, "utf8");

/**
 * Returns the body of the named top-level function declaration in the
 * source, between its opening `{` (after the parameter list) and the
 * matching closing `}` at column 0. We use a brace-balance walk rather
 * than a regex so nested template literals / object literals are
 * handled correctly.
 */
function extractFunctionBody(source: string, name: string): string {
	const decl = `function ${name}(`;
	const start = source.indexOf(decl);
	if (start < 0) {
		throw new Error(`function ${name} not found in source`);
	}
	// Find the `{` that opens the function body. It is the first `{`
	// after the parameter list's matching `)`. Walk parens.
	let i = start + decl.length;
	let parens = 1;
	while (i < source.length && parens > 0) {
		const c = source[i];
		if (c === "(") parens++;
		else if (c === ")") parens--;
		i++;
	}
	// Skip the optional return type annotation up to the opening brace.
	while (i < source.length && source[i] !== "{") i++;
	if (i >= source.length) {
		throw new Error(`could not locate body open-brace for ${name}`);
	}
	const bodyStart = i;
	let depth = 0;
	for (; i < source.length; i++) {
		const c = source[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(bodyStart, i + 1);
			}
		}
	}
	throw new Error(`unterminated function body for ${name}`);
}

const RUN_PLAN_DIALOG = extractFunctionBody(SOURCE, "RunPlanDialog");
const RUN_PLAN_BUTTON = extractFunctionBody(SOURCE, "RunPlanButton");

describe("PlotDetail RunPlanDialog — editable prompt template (pl-f666)", () => {
	test("declares DEFAULT_PROMPT_TEMPLATE with the documented value", () => {
		// pl-f666 acceptance: prompt textarea pre-fills with this
		// module-level constant. Keep the value in lockstep with
		// NewPlanRun.tsx so both dispatch entry points agree.
		expect(SOURCE).toContain('const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}"');
	});

	test("AC1: controlled promptTemplate state initialised to DEFAULT_PROMPT_TEMPLATE", () => {
		// Mirror of NewPlanRun.tsx ~line 300-320 (mx-9c6c6d).
		expect(RUN_PLAN_DIALOG).toMatch(/useState\(\s*DEFAULT_PROMPT_TEMPLATE\s*\)/);
		expect(RUN_PLAN_DIALOG).toMatch(/\[\s*promptTemplate\s*,\s*setPromptTemplate\s*\]/);
		expect(RUN_PLAN_DIALOG).toMatch(/\[\s*promptTouched\s*,\s*setPromptTouched\s*\]/);
	});

	test("AC1: renders a Textarea (not a ReadOnlyField) bound to promptTemplate", () => {
		// Regression guard: the original implementation (warren-5d94)
		// surfaced the prompt as a read-only field. Re-introducing that
		// would silently strip the user's ability to edit the prompt
		// before dispatch.
		expect(RUN_PLAN_DIALOG).toMatch(/<Textarea\b[\s\S]*?value=\{promptTemplate\}/);
		expect(RUN_PLAN_DIALOG).not.toMatch(/<ReadOnlyField[^>]*label=["']Prompt[^"']*["']/);
		// Textarea must wire onChange to both setters (touched flag is
		// what hides the "Default." hint once the user edits).
		expect(RUN_PLAN_DIALOG).toMatch(/setPromptTemplate\(\s*e\.target\.value\s*\)/);
		expect(RUN_PLAN_DIALOG).toMatch(/setPromptTouched\(\s*true\s*\)/);
	});

	test("AC2: trimmedPrompt is what flows into plotsApi.dispatchPlanRun", () => {
		// The dispatched promptTemplate must be the (trimmed) state
		// value — never the raw constant. This is the user-visible
		// "editing changes what gets sent" guarantee.
		expect(RUN_PLAN_DIALOG).toMatch(/const\s+trimmedPrompt\s*=\s*promptTemplate\.trim\(\)/);
		expect(RUN_PLAN_DIALOG).toMatch(
			/plotsApi\.dispatchPlanRun\(\{[\s\S]*?promptTemplate:\s*trimmedPrompt[\s\S]*?\}\)/,
		);
		// Belt-and-braces: nothing should still be passing the bare
		// constant to dispatchPlanRun in this function.
		const dispatchCallMatch = RUN_PLAN_DIALOG.match(/plotsApi\.dispatchPlanRun\(\{[\s\S]*?\}\)/);
		expect(dispatchCallMatch).not.toBeNull();
		expect(dispatchCallMatch?.[0]).not.toMatch(/promptTemplate:\s*DEFAULT_PROMPT_TEMPLATE/);
	});

	test("AC3: Dispatch button disabled when trimmed prompt is empty", () => {
		// readyToDispatch is the single source of truth for the
		// Dispatch button's `disabled` prop; it must include the
		// non-empty-trimmed-prompt guard.
		expect(RUN_PLAN_DIALOG).toMatch(/readyToDispatch\s*=[\s\S]*?trimmedPrompt\.length\s*>\s*0/);
		expect(RUN_PLAN_DIALOG).toMatch(/disabled=\{\s*!readyToDispatch\s*\}/);
		// And the dispatch mutationFn itself throws on empty prompt as
		// a defense-in-depth check (matches NewPlanRun's posture).
		expect(RUN_PLAN_DIALOG).toMatch(/if\s*\(\s*trimmedPrompt\.length\s*===\s*0\s*\)/);
	});

	test("AC4: dialog state resets on close-and-reopen via conditional mount", () => {
		// RunPlanButton conditionally renders <RunPlanDialog ...>:
		// closing the dialog unmounts it, so the next open mounts a
		// fresh component whose useState defaults fire again. This is
		// the structural guarantee that promptTemplate / promptTouched
		// reset to defaults without a useEffect reset hook.
		expect(RUN_PLAN_BUTTON).toMatch(/open\s*\?\s*\(\s*<RunPlanDialog[\s\S]*?\/>\s*\)\s*:\s*null/);
	});

	test("AC1: 'Default.' hint suppressed once the user edits the prompt", () => {
		// The hint copy ("Default.") only shows while !promptTouched
		// AND the value still equals the constant. Both conjuncts
		// matter — flipping either would change UX semantics.
		expect(RUN_PLAN_DIALOG).toMatch(
			/!promptTouched\s*&&\s*promptTemplate\s*===\s*DEFAULT_PROMPT_TEMPLATE[\s\S]*?"\s*Default\.\s*"/,
		);
	});

	test("AC5: RunPlanButton + RunPlanDialog prop signatures unchanged", () => {
		// pl-f666 explicitly forbade widening either component's
		// prop surface. RunPlanButton takes {plotId, projectId, planRef}
		// and RunPlanDialog adds onOpenChange — no more, no less.
		const buttonProps =
			SOURCE.match(/function RunPlanButton\(\{([\s\S]*?)\}: \{([\s\S]*?)\}\)/)?.[2] ?? "";
		const dialogProps =
			SOURCE.match(/function RunPlanDialog\(\{([\s\S]*?)\}: \{([\s\S]*?)\}\)/)?.[2] ?? "";
		expect(buttonProps).toContain("plotId: string");
		expect(buttonProps).toContain("projectId: string");
		expect(buttonProps).toContain("planRef: string");
		expect(buttonProps).not.toMatch(/promptTemplate/);
		expect(dialogProps).toContain("plotId: string");
		expect(dialogProps).toContain("projectId: string");
		expect(dialogProps).toContain("planRef: string");
		expect(dialogProps).toContain("onOpenChange:");
		expect(dialogProps).not.toMatch(/promptTemplate/);
	});
});
