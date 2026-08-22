#!/usr/bin/env bun
/**
 * The tracker, served against FakeJira instead of a real site.
 *
 * This is how the conformance suite runs without an Atlassian account:
 *
 *   bun run dev-server --port 8080
 *   cd ../tracker-conformance && bun run check http://127.0.0.1:8080
 *
 * It is the real handler, the real client and the real mapping. Only the
 * transport underneath is fake, so what the suite judges is this
 * package's protocol behavior end to end.
 */

import { loadConfig } from "./config.ts";
import { createFakeJira, SAMPLE_ISSUES } from "./fake-jira.ts";
import { createJiraTrackerHandler } from "./server.ts";

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

const config = loadConfig({
	JIRA_BASE_URL: "https://fake.atlassian.invalid",
	JIRA_EMAIL: "dev@fake.invalid",
	JIRA_API_TOKEN: "dev-token",
	JIRA_JQL: "project = WAR",
	TRACKER_PORT: flag("port") ?? "8080",
	...(flag("bearer") !== undefined ? { TRACKER_BEARER: flag("bearer") } : {}),
});

const jira = createFakeJira({ issues: SAMPLE_ISSUES });
const server = Bun.serve({
	port: config.port,
	hostname: "127.0.0.1",
	fetch: createJiraTrackerHandler({ config, fetchImpl: jira.fetchImpl }),
});

console.log(`tracker-jira (fake upstream) listening on ${server.port}`);
