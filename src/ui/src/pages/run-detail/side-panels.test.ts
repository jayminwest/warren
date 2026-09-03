import { expect, test } from "bun:test";

/**
 * warren-57fb rename guard: the panel is SpendPanel now. Asserted on
 * source rather than by rendering — the module's JSX needs a DOM to
 * load into a test, and the rename is a surface change worth pinning
 * either way.
 */

test("side-panels exports SpendPanel and BudgetPanel is gone", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes("export function SpendPanel(")).toBe(true);
	expect(src.includes("BudgetPanel")).toBe(false);
	expect(src.includes('title="Spend"')).toBe(true);
	expect(src.includes("MEASURED</span>")).toBe(false);
});

test("run detail page renders SpendPanel", async () => {
	const src = await Bun.file(new URL("./index.tsx", import.meta.url)).text();
	expect(src.includes("<SpendPanel run={r} />")).toBe(true);
	expect(src.includes("BudgetPanel")).toBe(false);
});

test("base commit row renders the resolved base_sha with the pin as labelled fallback (warren-b19e)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes('label="base commit"')).toBe(true);
	expect(src.includes("run.baseSha")).toBe(true);
	// The fallback arm shows the dispatch-time pin, explicitly labelled.
	expect(src.includes("base pin")).toBe(true);
});

test("Spend panel renders the '$X of $Y cap' denominator only when the overlay supplied a cap (warren-b19e)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes("of {formatCostUsd(cap)} cap")).toBe(true);
	expect(src.includes("% OF CAP")).toBe(true);
});
