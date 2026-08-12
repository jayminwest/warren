/**
 * GitHubAppForge — the GitHub App implementation of the `Forge` contract
 * (plan pl-d1c9 step 16, forge-contract.md §4/§5), a peer of the PAT-mode
 * `GitHubForge`.
 *
 * The design decision this provider carries (§4): credentials are minted,
 * never held. Nothing here stores a bearer token on a configuration
 * object — the installation token lives inside the
 * `InstallationTokenSource` cache and is re-minted on expiry, and every
 * API call mints immediately before its request.
 *
 * Structure: the whole PR/checks transport surface is ONE implementation
 * — `GitHubForge` — driven by a dynamic `tokenSource`. This class owns
 * only what App mode actually changes:
 *
 *   - the credential source (`InstallationTokenSource`, ./installation-tokens.ts),
 *   - the capability flags (§5: `checkRuns` YES — an installation token
 *     reaches the Checks API, confirmed live by the spike; `botIdentity`
 *     YES; `credentialLifetime: "short-lived"`),
 *   - `botIdentity()` — the App names its own bot (`<slug>[bot]`), read
 *     once from `GET /app` (JWT auth) and cached.
 *
 * Boot discipline (§2.2): the constructor THROWS `ForgeConfigError` on a
 * missing/blank config field or an unparseable private key — a
 * misconfigured short-lived backend fails loud at boot, mirroring the
 * registry's `UnknownForgeError`. Seam methods return `ForgeResult` and
 * never throw.
 *
 * Env contract (the registry's default factory reads these):
 *   - `WARREN_GITHUB_APP_ID`              — the App id (JWT `iss`).
 *   - `WARREN_GITHUB_APP_INSTALLATION_ID` — the installation to mint for.
 *   - `WARREN_GITHUB_APP_PRIVATE_KEY`     — the App's PEM private key
 *     (literal `\n` sequences are unfolded, the common secret-store form).
 */

import type { KeyObject } from "node:crypto";
import type {
	Forge,
	ForgeCapabilities,
	ForgeError,
	ForgeResult,
	GitIdentity,
	RepoRef,
} from "../contract.ts";
import { ForgeConfigError } from "../errors.ts";
import { GITHUB_API_BASE } from "../github/headers.ts";
import { requestGitHub } from "../github/http.ts";
import { GitHubForge, toForgeError } from "../github/provider.ts";
import { readJson } from "../github/readers.ts";
import { GITHUB_FORGE_KIND, parseGitHubRepoRef } from "../github/repo-ref.ts";
import { InstallationTokenSource } from "./installation-tokens.ts";
import { mintGitHubAppJwt, parseGitHubAppPrivateKey } from "./jwt.ts";

const USER_AGENT = "warren-forge-github-app";

/** Env vars the registry's default `app` arm reads. */
export const GITHUB_APP_ID_ENV = "WARREN_GITHUB_APP_ID";
export const GITHUB_APP_INSTALLATION_ID_ENV = "WARREN_GITHUB_APP_INSTALLATION_ID";
export const GITHUB_APP_PRIVATE_KEY_ENV = "WARREN_GITHUB_APP_PRIVATE_KEY";

/** The three inputs App mode needs. `privateKey` is a PEM string. */
export interface GitHubAppCredentials {
	readonly appId: string;
	readonly installationId: string;
	readonly privateKey: string;
}

export interface GitHubAppForgeOptions extends GitHubAppCredentials {
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Clock seam for tests; epoch ms. */
	readonly now?: () => number;
	/** Token-cache margin override for tests (see InstallationTokenSource). */
	readonly expiryMarginMs?: number;
}

/**
 * The registry's default credential factory for the `app` arm: read the
 * three env vars and fail loud — at boot, before any run dispatches —
 * when any is missing or blank.
 */
export function loadGitHubAppCredentialsFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): GitHubAppCredentials {
	const appId = env[GITHUB_APP_ID_ENV]?.trim() ?? "";
	const installationId = env[GITHUB_APP_INSTALLATION_ID_ENV]?.trim() ?? "";
	const privateKey = env[GITHUB_APP_PRIVATE_KEY_ENV] ?? "";
	const missing: string[] = [];
	if (appId === "") missing.push(GITHUB_APP_ID_ENV);
	if (installationId === "") missing.push(GITHUB_APP_INSTALLATION_ID_ENV);
	if (privateKey.trim() === "") missing.push(GITHUB_APP_PRIVATE_KEY_ENV);
	if (missing.length > 0) {
		throw new ForgeConfigError(`WARREN_FORGE=app requires ${missing.join(", ")} to be set`, {
			recoveryHint:
				"Set WARREN_GITHUB_APP_ID, WARREN_GITHUB_APP_INSTALLATION_ID, and WARREN_GITHUB_APP_PRIVATE_KEY (the PEM from the App's registration), or select a different WARREN_FORGE.",
		});
	}
	return { appId, installationId, privateKey };
}

export class GitHubAppForge implements Forge {
	readonly capabilities: ForgeCapabilities = {
		// §5: an installation token reaches the Checks API (spike-confirmed).
		checkRuns: true,
		jobLogs: true,
		pullRequestBodyEdit: true,
		branchDelete: true,
		botIdentity: true,
		credentialLifetime: "short-lived",
	};

	private readonly appId: string;
	private readonly appKey: KeyObject;
	private readonly fetch: typeof fetch;
	private readonly now: (() => number) | undefined;
	private readonly transport: GitHubForge;
	private cachedSlug: string | null = null;

	constructor(options: GitHubAppForgeOptions) {
		let appKey: KeyObject;
		try {
			appKey = parseGitHubAppPrivateKey(options.privateKey);
		} catch (cause) {
			throw new ForgeConfigError(
				`${GITHUB_APP_PRIVATE_KEY_ENV} is not a parseable PEM private key`,
				{
					recoveryHint:
						"Paste the full PEM (BEGIN/END lines included) from the GitHub App's private-key download; literal \\n sequences are unfolded automatically.",
					cause,
				},
			);
		}
		this.appId = options.appId;
		this.appKey = appKey;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now;
		this.transport = new GitHubForge({
			tokenSource: new InstallationTokenSource({
				appId: options.appId,
				privateKey: appKey,
				installationId: options.installationId,
				fetch: this.fetch,
				...(options.now !== undefined ? { now: options.now } : {}),
				...(options.expiryMarginMs !== undefined ? { expiryMarginMs: options.expiryMarginMs } : {}),
			}),
			fetch: this.fetch,
		});
	}

	parseRepoRef(cloneUrl: string): RepoRef | null {
		// The App owns the same github.com URL space as the PAT forge; refs
		// pack `github.com/<owner>/<repo>` under the shared "github" key.
		return parseGitHubRepoRef(cloneUrl);
	}

	gitCredential(ref: RepoRef): ReturnType<Forge["gitCredential"]> {
		return this.transport.gitCredential(ref);
	}

	openPullRequest(ref: RepoRef, req: Parameters<Forge["openPullRequest"]>[1]) {
		return this.transport.openPullRequest(ref, req);
	}

	findPullRequest(ref: RepoRef, q: Parameters<Forge["findPullRequest"]>[1]) {
		return this.transport.findPullRequest(ref, q);
	}

	getPullRequest(ref: RepoRef, pr: Parameters<Forge["getPullRequest"]>[1]) {
		return this.transport.getPullRequest(ref, pr);
	}

	setPullRequestBody(ref: RepoRef, pr: Parameters<Forge["setPullRequestBody"]>[1], body: string) {
		return this.transport.setPullRequestBody(ref, pr, body);
	}

	listChecks(ref: RepoRef, commit: string) {
		return this.transport.listChecks(ref, commit);
	}

	fetchJobLogTail(ref: RepoRef, jobId: string, maxBytes: number) {
		return this.transport.fetchJobLogTail(ref, jobId, maxBytes);
	}

	deleteBranch(ref: RepoRef, branch: string) {
		return this.transport.deleteBranch(ref, branch);
	}

	/**
	 * The App's bot identity (`<slug>[bot]`, §5). The slug is read once
	 * from `GET /app` under JWT auth and cached — it cannot change for the
	 * life of the process.
	 */
	async botIdentity(): Promise<ForgeResult<GitIdentity>> {
		const slug = await this.appSlug();
		if (!slug.ok) return slug;
		return {
			ok: true,
			value: {
				name: `${slug.value}[bot]`,
				email: `${slug.value}[bot]@users.noreply.github.com`,
			},
		};
	}

	private async appSlug(): Promise<ForgeResult<string>> {
		if (this.cachedSlug !== null) return { ok: true, value: this.cachedSlug };
		let jwt: string;
		try {
			jwt = mintGitHubAppJwt({
				appId: this.appId,
				privateKey: this.appKey,
				...(this.now !== undefined ? { now: this.now } : {}),
			});
		} catch (cause) {
			return {
				ok: false,
				error: {
					kind: "no_credential",
					detail: `failed to sign the GitHub App JWT: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			};
		}
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/app`,
			method: "GET",
			token: jwt,
			userAgent: USER_AGENT,
			context: "GET /app",
			fetch: this.fetch,
		});
		if (!result.ok) return { ok: false, error: toForgeError(result.error) };
		const body = (await readJson(result.response)) as { slug?: unknown } | null;
		if (typeof body?.slug !== "string" || body.slug === "") {
			const error: ForgeError = {
				kind: "http_error",
				detail: "GET /app returned no App slug",
			};
			return { ok: false, error };
		}
		this.cachedSlug = body.slug;
		return { ok: true, value: body.slug };
	}
}

/** Re-export so the conformance suite pins the ref key this forge packs. */
export { GITHUB_FORGE_KIND };
