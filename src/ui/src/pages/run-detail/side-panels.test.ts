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
