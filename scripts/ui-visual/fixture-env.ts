/**
 * The hand-off between `run.ts` (which boots the fixture under Bun) and
 * the Playwright specs (which run under Node): the fixture boot's JSON
 * output rides one env var. Pure, so `bun test` covers the parse.
 */

import type { FixtureBootOutput } from "./fixture-boot.ts";

export const FIXTURE_ENV = "WARREN_UI_VISUAL_FIXTURE";

const HINT =
	"run `bun run check:ui-visual`, or boot `bun run scripts/ui-visual/fixture-boot.ts --json` " +
	`and export its output line as ${FIXTURE_ENV}`;

/** Parse and shape-check the fixture boot output carried in `FIXTURE_ENV`. */
export function parseFixtureEnv(raw: string | undefined): FixtureBootOutput {
	if (raw === undefined || raw.trim() === "") throw new Error(`${FIXTURE_ENV} is not set: ${HINT}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`${FIXTURE_ENV} is not JSON (${(err as Error).message}): ${HINT}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`${FIXTURE_ENV} must be a JSON object: ${HINT}`);
	}
	const o = parsed as Record<string, unknown>;
	const missing = [
		["baseUrl", "string"],
		["token", "string"],
		["frozenNowMs", "number"],
		["uiServed", "boolean"],
		["ids", "object"],
	].filter(([key = "", type]) => typeof o[key] !== type || o[key] === null);
	if (missing.length > 0) {
		const names = missing.map(([key, type]) => `${key} (${type})`).join(", ");
		throw new Error(`${FIXTURE_ENV} is missing ${names}: ${HINT}`);
	}
	if (o.uiServed !== true) {
		throw new Error(`the fixture boot is not serving the SPA: run \`bun run build:ui\` first`);
	}
	return parsed as FixtureBootOutput;
}
