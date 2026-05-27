import { LOCAL_WORKER_NAME } from "../../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../cookie.ts";

export const TOKEN = "test-token-very-secret-1234567890abcdef";
export const HOST = "preview.warren.example.com";

export interface ProxyTestEnv {
	db: WarrenDb;
	repos: Repos;
	auth: PreviewAuth;
	runId: string;
	projectId: string;
}

export interface SetupOpts {
	/** Auth scope; default subdomain (cookie scoped to `.<HOST>`). */
	readonly scope?: "subdomain" | "path";
	/** Preview port to attach to the live run. */
	readonly previewPort?: number;
}

/**
 * Boot an in-memory warren db, a `PreviewAuth`, and a single live-
 * preview run so a handler test can call `createPreviewProxyHandler`
 * without restating the seed shape. Keeps every per-file `beforeEach`
 * to a single line.
 */
export async function setupProxyEnv(opts: SetupOpts = {}): Promise<ProxyTestEnv> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	const auth =
		opts.scope === "path"
			? createPreviewAuth(TOKEN, { secure: false, scope: { mode: "path" } })
			: createPreviewAuth(TOKEN, { secure: false });
	await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await repos.runs.create({
		agentName: "agent",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_x",
		workerId: LOCAL_WORKER_NAME,
	});
	await repos.runs.attachPreview(run.id, {
		previewState: "live",
		previewPort: opts.previewPort ?? 30100,
		previewStartedAt: "2026-01-01T00:00:00Z",
		previewLastHitAt: "2026-01-01T00:00:00Z",
	});
	return { db, repos, auth, runId: run.id, projectId: project.id };
}

export function fetchStub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}
