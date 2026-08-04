/**
 * Golden snapshot for `warren prime` (warren-fc12).
 *
 * The prime document derives from the live commander program definition
 * (`buildProgram`), so this fixture pins the contract an agent sees at
 * session start: the command reference, env contract, exit-code table,
 * and canonical workflows. Drift here means the CLI surface changed —
 * regenerate with
 *
 *   WARREN_UPDATE_GOLDENS=1 bun test src/cli/commands/prime.golden.test.ts
 *
 * then diff the fixture and commit only what you meant. See the sibling
 * convention in src/server/responses.golden.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../main.ts";
import type { CliContext } from "../output.ts";
import { buildPrimeDocument, renderPretty, runPrime } from "./prime.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "prime");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

function testProgram() {
	const context: CliContext = {
		env: {},
		stdio: { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	return buildProgram(context);
}

function compareGolden(name: string, actual: unknown): void {
	const path = join(GOLDEN_DIR, `${name}.json`);
	const serialized = `${JSON.stringify(actual, null, 2)}\n`;
	if (UPDATE) {
		mkdirSync(GOLDEN_DIR, { recursive: true });
		writeFileSync(path, serialized);
		return;
	}
	if (!existsSync(path)) {
		throw new Error(`missing golden ${path} — regenerate with WARREN_UPDATE_GOLDENS=1`);
	}
	expect(serialized).toBe(readFileSync(path, "utf8"));
}

describe("warren prime golden", () => {
	test("prime document matches the pinned fixture", () => {
		compareGolden("prime-document", buildPrimeDocument(testProgram()));
	});

	test("pretty rendering matches the pinned fixture", () => {
		compareGolden("prime-pretty", renderPretty(buildPrimeDocument(testProgram())));
	});

	test("runPrime emits ndjson by default and exits 0", async () => {
		const out: string[] = [];
		const context: CliContext = {
			env: {},
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: () => undefined },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};
		const result = await runPrime(context, { program: testProgram() });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(out.join("")) as { command: string; commands: unknown[] };
		expect(parsed.command).toBe("prime");
		expect(parsed.commands.length).toBeGreaterThan(0);
		const names = (parsed.commands as { name: string }[]).map((c) => c.name);
		expect(names).toContain("login");
		expect(names).toContain("prime");
		expect(names).toContain("plan run");
	});
});
