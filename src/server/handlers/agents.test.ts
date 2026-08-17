import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

async function depsFor(
	repos: Repos,
	provider: FakeProvider,
	bridges?: BridgeRegistry,
	_extras?: Record<string, never>,
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	return {
		repos,
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				runtimeProvider: provider,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		// No-op spawn so the project-refresh path inside `POST /runs` and
		// `POST /projects/:id/refresh` doesn't shell out to real `git`
		// against tmpdir paths the test never populated. Tests that need
		// to assert on spawn calls override `deps.spawn` directly.
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

/* Agents handlers (extracted from handlers.test.ts, warren-599c / pl-9088 step 3). */

describe("GET /agents — listing with source provenance (warren-d3e9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns source: 'builtin' when frontmatter.source === 'builtin'", async () => {
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: ["builtin:claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("builtin");
	});

	test("returns source: 'library' for canopy-loaded rows (no source frontmatter)", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("library");
	});
});
