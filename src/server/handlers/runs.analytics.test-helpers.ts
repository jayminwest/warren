/**
 * Shared fixtures for the run-analytics handler tests (split under the
 * file-size budget, warren-be04): the in-memory server boot, the pinned
 * analytics window, and the run-seeding helpers both suites use.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunState } from "../../db/schema.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function depsFor(repos: Repos): ServerDeps {
	const broker = new RunEventBroker();
	const provider = new FakeProvider();
	return {
		repos,
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: provider,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

// warren-ec44: these suites seed runs at fixed 2026-05 dates, so they must
// pin an explicit ?from/?to window rather than rely on the handler's default
// "last 30 days" relative to the system clock (which excludes the data once
// the wall clock advances past it).
export const WINDOW = "from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z";

export interface SeedRunOpts {
	projectId: string;
	agentName: string;
	provider: string;
	model: string;
	seedId?: string | null;
	state: RunState;
	failureReason?: RunFailureReason | null;
	tokensInput?: number | null;
	tokensCacheRead?: number | null;
	tokensOutput?: number | null;
	tokensCacheWrite?: number | null;
	costUsd?: number | null;
	startedAt: string;
	endedAt?: string;
}

export async function seedRun(repos: Repos, opts: SeedRunOpts): Promise<string> {
	const run = await repos.runs.create({
		agentName: opts.agentName,
		projectId: opts.projectId,
		prompt: "p",
		renderedAgentJson: { frontmatter: { provider: opts.provider, model: opts.model } },
		trigger: "manual",
		seedId: opts.seedId ?? null,
		now: new Date(opts.startedAt),
	});
	await repos.runs.markRunning(run.id, new Date(opts.startedAt));
	if (opts.state !== "running" && opts.state !== "queued") {
		await repos.runs.finalize(
			run.id,
			opts.state as "succeeded" | "failed" | "cancelled",
			new Date(opts.endedAt ?? opts.startedAt),
			opts.failureReason ?? null,
		);
	}
	if (
		opts.tokensInput !== undefined ||
		opts.tokensCacheRead !== undefined ||
		opts.tokensOutput !== undefined ||
		opts.tokensCacheWrite !== undefined ||
		opts.costUsd !== undefined
	) {
		await repos.runs.attachStats(run.id, {
			tokensInput: opts.tokensInput ?? null,
			tokensCacheRead: opts.tokensCacheRead ?? null,
			tokensOutput: opts.tokensOutput ?? null,
			tokensCacheWrite: opts.tokensCacheWrite ?? null,
			costUsd: opts.costUsd ?? null,
		});
	}
	return run.id;
}

/** Write the merge watcher's PR fact onto a seeded run (warren-3bc6). */
export async function setRunPrState(
	repos: Repos,
	runId: string,
	prState: "open" | "merged" | "closed_unmerged",
): Promise<void> {
	await repos.runs.setPrState(
		runId,
		prState,
		prState === "merged" ? "2026-05-21T00:00:00.000Z" : null,
	);
}

export { NO_AUTH, startServer };
