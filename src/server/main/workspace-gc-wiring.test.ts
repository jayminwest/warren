import { describe, expect, test } from "bun:test";
import type { WorkspaceGcReposLike } from "../../runs/reap/gc.ts";
import type { Logger } from "../types.ts";
import { bootWorkspaceGc } from "./workspace-gc-wiring.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: object;
	readonly msg?: string;
}

function makeLogger(): { logger: Logger; lines: LogLine[] } {
	const lines: LogLine[] = [];
	const push = (level: LogLine["level"]) => (obj: object, msg?: string) => {
		lines.push(msg === undefined ? { level, obj } : { level, obj, msg });
	};
	const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
	return { logger, lines };
}

function emptyRepos(): WorkspaceGcReposLike {
	return {
		runs: { listByState: async () => [], clearBurrowIdForWorkspace: async () => {} },
	};
}

const CONFIG = { ttlMs: 60_000, tickMs: 60_000, disabled: false };

describe("bootWorkspaceGc (warren-0a9a)", () => {
	test("boots the sweep with the operator config when a destroyer came down from the runtime", async () => {
		const { logger, lines } = makeLogger();
		const worker = bootWorkspaceGc({
			repos: emptyRepos(),
			workspaceDestroyer: async () => ({ status: "already-gone" as const }),
			config: CONFIG,
			logger,
		});
		expect(lines.at(-1)).toEqual({
			level: "info",
			obj: CONFIG,
			msg: "workspace GC worker running",
		});
		// The sweep is live: one manual tick scans the (empty) terminal set.
		expect(await worker.runOnce()).toEqual({
			scanned: 0,
			stranded: 0,
			destroyed: 0,
			failed: 0,
		});
		await worker.stop();
	});

	test("force-disables the worker when the runtime lacks the workspaceGc capability", async () => {
		const { logger, lines } = makeLogger();
		const worker = bootWorkspaceGc({
			repos: emptyRepos(),
			workspaceDestroyer: undefined,
			config: CONFIG,
			logger,
		});
		expect(lines.at(-1)).toEqual({
			level: "info",
			obj: { ...CONFIG, disabled: true },
			msg: "workspace GC disabled (WARREN_WORKSPACE_GC_DISABLED or runtime lacks workspaceGc capability)",
		});
		// The operator config object itself is not mutated.
		expect(CONFIG.disabled).toBe(false);
		await worker.stop();
	});
});
