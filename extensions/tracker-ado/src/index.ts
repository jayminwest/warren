#!/usr/bin/env bun
/**
 * Entrypoint. Reads the environment, fails loud on a bad one, and serves.
 *
 * The Azure DevOps credential never leaves this process and is never
 * logged. The boot line names the organization, the project and the
 * query so an operator can see WHICH board and WHICH work items this
 * container speaks for, which is the pair that goes wrong in practice.
 */

import { type AdoTrackerConfig, ConfigError, loadConfig } from "./config.ts";
import { startAdoTracker } from "./server.ts";

async function main(): Promise<void> {
	let config: AdoTrackerConfig;
	try {
		config = loadConfig(process.env);
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`tracker-ado: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}
	const server = await startAdoTracker({ config });
	console.log(
		`tracker-ado listening on ${server.port} (org ${config.orgUrl}, project ${config.project}, auth ${config.auth.kind}, wiql ${config.wiql})`,
	);
}

if (import.meta.main) await main();
