#!/usr/bin/env bun
/**
 * The tracker, served against FakeAdo instead of a real organization.
 *
 * This is how the conformance suite runs without an Azure DevOps account:
 *
 *   bun run dev-server --port 8080
 *   cd ../tracker-conformance && bun run check http://127.0.0.1:8080
 *
 * It is the real handler, the real client and the real mapping. Only the
 * transport underneath is fake, so what the suite judges is this
 * package's protocol behavior end to end.
 */

import { loadConfig } from "./config.ts";
import { createFakeAdo, SAMPLE_ITEMS } from "./fake-ado.ts";
import { createAdoTrackerHandler } from "./server.ts";

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

const config = loadConfig({
	ADO_ORG_URL: "https://dev.azure.invalid/fake",
	ADO_PROJECT: "Fake",
	ADO_PAT: "dev-token",
	ADO_WIQL: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
	TRACKER_PORT: flag("port") ?? "8080",
	...(flag("bearer") !== undefined ? { TRACKER_BEARER: flag("bearer") } : {}),
});

const ado = createFakeAdo({ items: SAMPLE_ITEMS });
const server = Bun.serve({
	port: config.port,
	hostname: "127.0.0.1",
	fetch: createAdoTrackerHandler({ config, fetchImpl: ado.fetchImpl }),
});

console.log(`tracker-ado (fake upstream) listening on ${server.port}`);
