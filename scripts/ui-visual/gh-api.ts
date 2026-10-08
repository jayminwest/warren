/**
 * The GitHub REST seam for the ui-visual PR-comment workflows (warren-70d9).
 *
 * `GhApi` is what `sticky-comment.ts` and `artifact-branch.ts` call; tests
 * pass a fake. `ghCliApi` is the real transport: it shells out to `gh api`
 * (preinstalled on GitHub runners, authenticated by `GH_TOKEN`), the same
 * way `scripts/report-acceptance.ts` does, so no REST host literal lives in
 * `scripts/` (the `github-api-literal-is-forge-only` layer rule).
 */

import { spawnSync } from "node:child_process";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GhApi {
	/** One request. Resolves the parsed JSON body (null for an empty body). */
	request(method: HttpMethod, path: string, body?: unknown): Promise<unknown>;
	/** A GET that follows every page and returns the concatenated array items. */
	paginate(path: string): Promise<unknown[]>;
}

/** A failed `gh api` call; `status` is the HTTP status when gh printed one. */
export class GhApiError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = "GhApiError";
	}
}

const MAX_BUFFER = 64 * 1024 * 1024;

function runGh(args: string[], input?: string, token?: string): string {
	const env = token === undefined ? process.env : { ...process.env, GH_TOKEN: token };
	const result = spawnSync("gh", args, { encoding: "utf8", input, env, maxBuffer: MAX_BUFFER });
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
		throw new GhApiError(
			`gh ${args.slice(0, 4).join(" ")} failed: ${stderr}`,
			status === undefined ? null : Number(status),
		);
	}
	return result.stdout;
}

function parse(text: string): unknown {
	return text.trim() === "" ? null : JSON.parse(text);
}

/**
 * The `gh api` transport. Needs `GH_TOKEN` (or a `gh auth login`) in the
 * env, or an explicit `token` for a job that holds two (warren-a694).
 */
export function ghCliApi(token?: string): GhApi {
	return {
		request(method, path, body) {
			const args = ["api", "--method", method, path];
			if (body !== undefined) args.push("--input", "-");
			const input = body === undefined ? undefined : JSON.stringify(body);
			return Promise.resolve(parse(runGh(args, input, token)));
		},
		paginate(path) {
			const pages = parse(runGh(["api", "--paginate", "--slurp", path], undefined, token));
			if (!Array.isArray(pages)) return Promise.resolve([]);
			return Promise.resolve(pages.flatMap((page) => (Array.isArray(page) ? page : [page])));
		},
	};
}

/** True for an error whose HTTP status is `status`. */
export function isHttpStatus(error: unknown, status: number): boolean {
	return error instanceof GhApiError && error.status === status;
}
