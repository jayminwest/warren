#!/usr/bin/env bun
/**
 * Entrypoint. Reads the environment, fails loud on a bad one, and serves.
 *
 * The Jira credential never leaves this process and is never logged. The
 * boot line names the site and the query so an operator can see WHICH
 * Jira and WHICH issues this container speaks for, which is the pair that
 * goes wrong in practice.
 */

import { ConfigError, loadConfig } from "./config.ts";
import { startJiraTracker } from "./server.ts";

async function main(): Promise<void> {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(process.env);
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`tracker-jira: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}
	const server = await startJiraTracker({ config });
	console.log(
		`tracker-jira listening on ${server.port} (site ${config.baseUrl}, auth ${config.auth.kind}, jql ${config.jql})`,
	);
}

if (import.meta.main) await main();
