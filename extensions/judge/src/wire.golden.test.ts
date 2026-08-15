import { describe, expect, test } from "bun:test";
import { parseVerdict, VERDICT_CLASSES, VerdictValidationError } from "./wire.ts";

/**
 * Golden pins for the rubric-v1 verdict wire shape (agent-analytics §12.3).
 * The fixtures under `__golden__/` lock the JSON an on-disk verdict must
 * parse into, so an accidental shape change fails here instead of corrupting
 * the corpus. Regenerate after an intentional change with:
 *   JUDGE_UPDATE_GOLDENS=1 bun test src/wire.golden.test.ts
 */
const FIXTURES = ["verdict.valid.json", "verdict.clean.json"] as const;

async function readFixture(name: string): Promise<unknown> {
	return JSON.parse(await Bun.file(new URL(`__golden__/${name}`, import.meta.url)).text());
}

async function maybeRewrite(name: string, value: unknown): Promise<void> {
	if (process.env.JUDGE_UPDATE_GOLDENS !== "1") return;
	await Bun.write(
		new URL(`__golden__/${name}`, import.meta.url),
		`${JSON.stringify(value, null, "\t")}\n`,
	);
}

describe("verdict golden fixtures", () => {
	for (const name of FIXTURES) {
		test(`pins the ${name} shape`, async () => {
			const raw = await readFixture(name);
			const parsed = parseVerdict(raw);
			// Re-serialization is the pin: the on-disk JSON must round-trip
			// through the parser byte-for-byte, so field renames or drops fail.
			await maybeRewrite(name, parsed);
			expect(JSON.parse(await Bun.file(new URL(`__golden__/${name}`, import.meta.url)).text()))
				.toEqual(parsed);
		});
	}

	test("every rubric-v1 class parses as an assignment", () => {
		for (const cls of VERDICT_CLASSES) {
			const verdict = {
				runId: "run_taxonomy",
				assignments: [
					cls === "clean"
						? { class: cls, confidence: "high", evidence: [] }
						: { class: cls, confidence: "high", evidence: [{ fromSeq: 1, toSeq: 2 }] },
				],
				provenance: {
					provider: "anthropic",
					model: "claude-haiku-4-5",
					rubricVersion: "sha256:taxonomy",
					judgedAt: "2026-08-15T16:04:11.000Z",
					costUsd: 0.001,
				},
			};
			expect(() => parseVerdict(verdict)).not.toThrow(VerdictValidationError);
		}
	});
});
