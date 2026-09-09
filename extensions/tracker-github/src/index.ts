#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { loadDispatchConfig } from "./dispatch/config.ts";
import { QueueController } from "./dispatch/controller.ts";
import { DispatchStore } from "./dispatch/store.ts";
import { WarrenClient } from "./dispatch/warren.ts";
import { ConfigError, TrackerFailure } from "./errors.ts";
import { GitHubClient } from "./github/client.ts";
import { createHandler } from "./server.ts";

export async function start(env: Readonly<Record<string, string | undefined>> = process.env) {
	const config = loadConfig(env);
	const dispatch = loadDispatchConfig(env);
	const github = new GitHubClient(config);
	// Resolve scope/field/options and credential permissions before serving or starting a scheduler.
	await github.listIssues();
	const store = dispatch ? new DispatchStore(dispatch.database) : undefined;
	const controller =
		dispatch && store
			? new QueueController(dispatch, github, new WarrenClient(dispatch), store)
			: undefined;
	const server = Bun.serve({
		port: config.port,
		fetch: createHandler(config, github, store),
		idleTimeout: 120,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let active: Promise<void> | undefined;
	const poll = async () => {
		try {
			await controller?.tick();
		} catch (error) {
			console.error(
				`tracker-github automatic pickup: ${error instanceof TrackerFailure ? error.code : "internal_error"}`,
			);
		}
		if (!stopped && dispatch)
			timer = setTimeout(() => {
				active = poll();
			}, dispatch.intervalMs);
	};
	if (controller) active = poll();
	return {
		server,
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await active;
			server.stop(true);
			store?.close();
		},
	};
}

if (import.meta.main) {
	try {
		const handle = await start();
		console.log(`tracker-github listening on ${handle.server.port}`);
		let stopping = false;
		const stop = () => {
			if (!stopping) {
				stopping = true;
				void handle.stop();
			}
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	} catch (error) {
		console.error(
			error instanceof ConfigError
				? error.message
				: error instanceof TrackerFailure
					? error.code
					: "tracker-github failed to start",
		);
		process.exitCode = 1;
	}
}
