/**
 * Conformance CLI (warren-53ea): run the warren-tracker/v1 suite against
 * any server URL.
 *
 *   bun run src/check.ts <baseUrl> [--bearer <token>]
 *
 * Exit code 0 = the server conforms; 1 = failures (each printed). This
 * is the command a foreign tracker author runs before claiming
 * warren-tracker/v1 support.
 */

import { runConformanceSuite } from "./conformance.ts";

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const baseUrl = argv[0];
	if (baseUrl === undefined || baseUrl.startsWith("--")) {
		console.error("usage: bun run src/check.ts <baseUrl> [--bearer <token>]");
		return 2;
	}
	let bearerToken: string | undefined;
	const bearerIndex = argv.indexOf("--bearer");
	if (bearerIndex !== -1) {
		bearerToken = argv[bearerIndex + 1];
		if (bearerToken === undefined) {
			console.error("--bearer requires a value");
			return 2;
		}
	}

	const result = await runConformanceSuite({
		baseUrl,
		...(bearerToken !== undefined ? { bearerToken } : {}),
	});
	console.log(
		`warren-tracker/v1 conformance: ${result.casesRun} case groups against ${baseUrl}` +
			(result.versionNegotiated ? "" : " (rejected at protocol-version negotiation)"),
	);
	for (const failure of result.failures) {
		console.error(`  FAIL ${failure.case}: ${failure.detail}`);
	}
	if (result.passed) {
		console.log("PASS — the server conforms to warren-tracker/v1 (experimental)");
		return 0;
	}
	console.error(`FAIL — ${result.failures.length} conformance failure(s)`);
	return 1;
}

if (import.meta.main) {
	process.exit(await main());
}
