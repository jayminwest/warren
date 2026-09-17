import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatOutcomes, type ScenarioOutcome } from "./assert.ts";

/** Preserve the scoreboard as data for the nightly issue reporter (#1271). */
export async function reportOutcomes(outcomes: readonly ScenarioOutcome[]): Promise<void> {
	console.log(formatOutcomes(outcomes));
	const path = process.env.WARREN_ACCEPTANCE_RESULTS;
	if (!path) return;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ outcomes }));
}
