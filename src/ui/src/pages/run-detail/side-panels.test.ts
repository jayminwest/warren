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

test("base commit row shows the measured baseSha, falling back to the pin (warren-b19e)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes('label={run.baseSha != null ? "base commit" : "base pin"}')).toBe(true);
	expect(src.includes("run.baseSha ?? run.baseCommit")).toBe(true);
});

test("SpendPanel renders the cap denominator only when maxCostUsd is present (warren-b19e)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes("OF {formatCostUsd(run.maxCostUsd ?? 0)} CAP")).toBe(true);
	expect(src.includes("run.maxCostUsd != null")).toBe(true);
});
