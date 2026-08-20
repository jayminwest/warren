/**
 * FakeTracker CLI (warren-53ea) — run the reference warren-tracker/v1
 * server as a standalone process:
 *
 *   bun run src/fake-tracker.ts [--port 8080] [--fixture state.json] \
 *     [--state-file mirror.json] [--bearer <token>] \
 *     [--protocol-version <override>] \
 *     [--no-plans] [--no-metadata] [--no-scheduled-issues] [--git-native]
 *
 * Prints `fake-tracker listening on <port>` once bound (line protocol a
 * spawning harness reads). `--port 0` picks an ephemeral port.
 *
 * `--fixture` seeds the in-memory store from a FakeTrackerFixture JSON
 * file; `--state-file` mirrors every mutation (plus a recorded-call
 * journal) to disk so another process can assert what the tracker saw.
 */

import { readFile } from "node:fs/promises";

import { startFakeTracker } from "./fake-tracker/server.ts";
import { FakeTrackerStore, type FakeTrackerFixture } from "./fake-tracker/store.ts";

export interface FakeTrackerCliArgs {
	readonly port: number;
	readonly fixturePath?: string;
	readonly stateFilePath?: string;
	readonly bearerToken?: string;
	readonly protocolVersion?: string;
	readonly capabilities: {
		readonly supportsPlans: boolean;
		readonly supportsMetadata: boolean;
		readonly supportsScheduledIssues: boolean;
		readonly isGitNative: boolean;
	};
}

export function parseFakeTrackerArgs(argv: readonly string[]): FakeTrackerCliArgs {
	let port = 8080;
	let fixturePath: string | undefined;
	let stateFilePath: string | undefined;
	let bearerToken: string | undefined;
	let protocolVersion: string | undefined;
	let supportsPlans = true;
	let supportsMetadata = true;
	let supportsScheduledIssues = true;
	let isGitNative = false;

	const takeValue = (flag: string, rest: readonly string[]): string => {
		const value = rest[0];
		if (value === undefined) throw new Error(`${flag} requires a value`);
		return value;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		switch (arg) {
			case "--port":
				port = Number.parseInt(takeValue(arg, argv.slice(i + 1)), 10);
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					throw new Error(`--port must be an integer 0..65535, got ${argv[i + 1]}`);
				}
				i++;
				break;
			case "--fixture":
				fixturePath = takeValue(arg, argv.slice(i + 1));
				i++;
				break;
			case "--state-file":
				stateFilePath = takeValue(arg, argv.slice(i + 1));
				i++;
				break;
			case "--bearer":
				bearerToken = takeValue(arg, argv.slice(i + 1));
				i++;
				break;
			case "--protocol-version":
				protocolVersion = takeValue(arg, argv.slice(i + 1));
				i++;
				break;
			case "--no-plans":
				supportsPlans = false;
				break;
			case "--no-metadata":
				supportsMetadata = false;
				break;
			case "--no-scheduled-issues":
				supportsScheduledIssues = false;
				break;
			case "--git-native":
				isGitNative = true;
				break;
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}

	return {
		port,
		...(fixturePath !== undefined ? { fixturePath } : {}),
		...(stateFilePath !== undefined ? { stateFilePath } : {}),
		...(bearerToken !== undefined ? { bearerToken } : {}),
		...(protocolVersion !== undefined ? { protocolVersion } : {}),
		capabilities: { supportsPlans, supportsMetadata, supportsScheduledIssues, isGitNative },
	};
}

async function loadFixture(path: string | undefined): Promise<FakeTrackerFixture> {
	if (path === undefined) return {};
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as FakeTrackerFixture;
}

async function main(): Promise<void> {
	const args = parseFakeTrackerArgs(process.argv.slice(2));
	const fixture = await loadFixture(args.fixturePath);
	const store = new FakeTrackerStore(fixture, args.stateFilePath);
	const running = await startFakeTracker({
		store,
		port: args.port,
		capabilities: args.capabilities,
		...(args.bearerToken !== undefined ? { bearerToken: args.bearerToken } : {}),
		...(args.protocolVersion !== undefined ? { protocolVersion: args.protocolVersion } : {}),
	});
	// The line protocol: spawners poll stdout for this exact prefix.
	console.log(`fake-tracker listening on ${running.port}`);
}

if (import.meta.main) {
	await main();
}
