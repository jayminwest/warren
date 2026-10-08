import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	BUDGETS_REL,
	compare,
	countArbitrary,
	countTree,
	loadBudgets,
	lowerBudgets,
	main,
	scan,
	writeBudgets,
} from "./check-tailwind-arbitrary.ts";

describe("countArbitrary", () => {
	test("counts each prefix-[value] literal", () => {
		expect(countArbitrary(`className="text-[10px] leading-[14px] px-2"`)).toBe(2);
		expect(countArbitrary(`className="md:w-[110px] -mt-[3px] flex-[1.8]"`)).toBe(3);
	});

	test("ignores the token-utility form", () => {
		expect(countArbitrary(`className="text-(--color-text-3) rounded-(--radius-sm)"`)).toBe(0);
	});

	test("ignores data-[...] and other bracketed variants", () => {
		const src = `className="data-[state=open]:animate-in group-data-[x=y]:hidden aria-[busy]:opacity-50"`;
		expect(countArbitrary(src)).toBe(0);
	});

	test("still counts the value behind a variant", () => {
		expect(countArbitrary(`className="data-[state=open]:w-[12px]"`)).toBe(1);
	});
});

describe("compare", () => {
	test("fails a file absent from the budget that has any hit", () => {
		const { failures } = compare({ "a.tsx": 1 }, {});
		expect(failures).toEqual([{ path: "a.tsx", count: 1, budget: 0 }]);
	});

	test("fails a file that grows past its budget", () => {
		const { failures } = compare({ "a.tsx": 4 }, { "a.tsx": 3 });
		expect(failures).toEqual([{ path: "a.tsx", count: 4, budget: 3 }]);
	});

	test("passes a file that shrinks below its budget", () => {
		const { failures, staleBudgetEntries } = compare({ "a.tsx": 2 }, { "a.tsx": 3 });
		expect(failures).toEqual([]);
		expect(staleBudgetEntries).toEqual([]);
	});

	test("reports a budget entry whose file has no hits left as stale", () => {
		expect(compare({}, { "gone.tsx": 2 }).staleBudgetEntries).toEqual(["gone.tsx"]);
	});
});

describe("lowerBudgets", () => {
	test("lowers shrunk entries and drops the ones at zero", () => {
		expect(lowerBudgets({ "a.tsx": 2 }, { "a.tsx": 5, "b.tsx": 1 })).toEqual({ "a.tsx": 2 });
	});

	test("refuses to raise a budget", () => {
		expect(lowerBudgets({ "a.tsx": 6 }, { "a.tsx": 5 })).toBeNull();
		expect(lowerBudgets({ "new.tsx": 1 }, {})).toBeNull();
	});
});

describe("check-tailwind-arbitrary on a fixture tree", () => {
	let root: string;
	const put = (rel: string, body: string) => {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	};
	const page = (n: number) =>
		`export const X = () => <div className="${Array.from({ length: n }, (_, i) => `w-[${i + 1}px]`).join(" ")}" />;\n`;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tw-arbitrary-"));
		mkdirSync(join(root, "scripts"), { recursive: true });
		put("src/ui/src/pages/a.tsx", page(3));
		put("src/ui/src/pages/a.test.tsx", page(9));
		writeBudgets(root, { "src/ui/src/pages/a.tsx": 3 });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("skips test files when counting", () => {
		expect(countTree(root)).toEqual({ "src/ui/src/pages/a.tsx": 3 });
	});

	test("fails when a new file with hits appears", () => {
		put("src/ui/src/pages/b.tsx", page(1));
		expect(scan(root).failures.map((f) => f.path)).toEqual(["src/ui/src/pages/b.tsx"]);
		expect(main([], root)).toBe(1);
	});

	test("fails when a budgeted file grows", () => {
		put("src/ui/src/pages/a.tsx", page(4));
		expect(main([], root)).toBe(1);
	});

	test("passes on a decrease, and --update lowers the budget", () => {
		put("src/ui/src/pages/a.tsx", page(1));
		expect(main([], root)).toBe(0);
		expect(main(["--update"], root)).toBe(0);
		expect(loadBudgets(root)).toEqual({ "src/ui/src/pages/a.tsx": 1 });
	});

	test("--update refuses to raise and leaves the budget file untouched", () => {
		const before = readFileSync(join(root, BUDGETS_REL), "utf8");
		put("src/ui/src/pages/a.tsx", page(5));
		expect(main(["--update"], root)).toBe(1);
		expect(readFileSync(join(root, BUDGETS_REL), "utf8")).toBe(before);
	});

	test("--headroom reports and never fails", () => {
		put("src/ui/src/pages/a.tsx", page(9));
		expect(main(["--headroom", "0"], root)).toBe(0);
	});
});

describe("check-tailwind-arbitrary on the repo", () => {
	test("current tree passes the budget guard", () => {
		const { failures, staleBudgetEntries } = scan();
		expect(failures).toEqual([]);
		expect(staleBudgetEntries).toEqual([]);
	});
});
