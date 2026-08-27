/**
 * Opt-in GitHub App credential persistence (warren-b504, plan pl-26f3
 * step 7).
 *
 * By default the manifest flow persists NOTHING: the callback renders the
 * credential set once ("warren keeps no copy") and the operator pastes it
 * into their secret store. This module is the OPT-IN alternative — armed
 * only by `WARREN_APP_CRED_STORE=data-dir` — where warren itself keeps the
 * App credential triple under the server data dir so the flow can end
 * with warren USING the App instead of showing env blocks.
 *
 * Security posture (see SECURITY.md):
 *
 *   - The file lives under `WARREN_DATA_DIR` (NOT the repo), named
 *     `github-app-credentials.json`, mode 0600, parent dir 0700.
 *   - The stored private key is NEVER logged. Error messages carry the
 *     file path and the field NAMES at most.
 *   - A `WARREN_AUTH=public` instance refuses the store outright: a
 *     stranger-reachable deployment must not grow a credential surface.
 *   - Re-registration overwrites with the newest App and drops the stale
 *     installation id (a new App needs a new installation).
 *
 * This module is forge-inward (warren-89a6): the HTTP handlers in
 * `src/server/handlers/github-app.ts` consume it, and only `src/forge/**`
 * owns the credential material's storage.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError } from "../../core/errors.ts";

/** The opt-in knob. Only the value `data-dir` arms the store. */
export const APP_CRED_STORE_ENV = "WARREN_APP_CRED_STORE";

/** The one recognized arming value. */
export const APP_CRED_STORE_MODE = "data-dir";

/** File name under the data dir. Sibling layout matches the operator token. */
export const GITHUB_APP_CREDENTIAL_FILE = "github-app-credentials.json";

/** Minimal env surface the arming resolver reads. */
export type AppCredStoreEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolve whether the credential store is armed. Default OFF.
 *
 *   - Unset/blank → OFF (today's render-once page, byte-identical).
 *   - `data-dir` → ON.
 *   - Anything else → `ValidationError` (fail loud, never silently
 *     default — the same posture as `WARREN_AUTH` and the registration
 *     gate).
 *   - `data-dir` + `WARREN_AUTH=public` → `ValidationError`: public-auth
 *     instances refuse the store.
 */
export function resolveAppCredStoreEnabled(env: AppCredStoreEnv = process.env): boolean {
	const raw = env[APP_CRED_STORE_ENV]?.trim();
	if (raw === undefined || raw === "") return false;
	if (raw !== APP_CRED_STORE_MODE) {
		throw new ValidationError(`Unknown ${APP_CRED_STORE_ENV} "${raw}"`, {
			recoveryHint: `Set ${APP_CRED_STORE_ENV} to "${APP_CRED_STORE_MODE}" (or leave it unset — default keeps nothing).`,
		});
	}
	if ((env.WARREN_AUTH ?? "").trim().toLowerCase() === "public") {
		throw new ValidationError(
			`${APP_CRED_STORE_ENV}=${APP_CRED_STORE_MODE} is refused on a WARREN_AUTH=public instance`,
			{
				recoveryHint:
					"A stranger-reachable deployment keeps no credential store. Remove the env var, or run the instance with token auth.",
			},
		);
	}
	return true;
}

/**
 * The stored (possibly partial) App credential triple. `installationId`
 * is absent until the `/github-app/installed` return route completes it.
 */
export interface StoredGitHubAppCredential {
	readonly appId: string;
	readonly privateKey: string;
	readonly installationId?: string;
}

/** Whether the triple is complete enough to build a `GitHubAppForge`. */
export function isCompleteCredential(
	credential: StoredGitHubAppCredential | null,
): credential is StoredGitHubAppCredential & { readonly installationId: string } {
	return (
		credential !== null &&
		credential.appId !== "" &&
		credential.privateKey !== "" &&
		credential.installationId !== undefined &&
		credential.installationId !== ""
	);
}

/**
 * JSON-file-backed store. One instance owns one file path; all methods
 * are synchronous (the file is a few KB and the routes are human-driven).
 */
export class GitHubAppCredentialStore {
	constructor(private readonly filePath: string) {}

	get path(): string {
		return this.filePath;
	}

	/** Read the stored (partial) triple, or null when nothing is stored. */
	read(): StoredGitHubAppCredential | null {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (parsed === null || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record.appId !== "string" || record.appId === "") return null;
		if (typeof record.privateKey !== "string" || record.privateKey === "") return null;
		const installationId = record.installationId;
		return {
			appId: record.appId,
			privateKey: record.privateKey,
			...(typeof installationId === "string" && installationId !== "" ? { installationId } : {}),
		};
	}

	/**
	 * Store the App half of the triple from a manifest conversion. A
	 * re-registration overwrites: the newest App wins and any stale
	 * installation id is dropped (the old App's installation does not
	 * authorize the new one's tokens).
	 */
	storeApp(appId: string, privateKey: string): void {
		const existing = this.read();
		const installationId =
			existing !== null &&
			existing.appId === appId &&
			existing.installationId !== undefined &&
			existing.installationId !== ""
				? existing.installationId
				: undefined;
		this.write({
			appId,
			privateKey,
			...(installationId !== undefined ? { installationId } : {}),
		});
	}

	/**
	 * Complete the triple with the installation id. Returns the completed
	 * triple, or null when no App half is stored (nothing to complete).
	 */
	completeInstallation(installationId: string): StoredGitHubAppCredential | null {
		const existing = this.read();
		if (existing === null) return null;
		const completed: StoredGitHubAppCredential = {
			appId: existing.appId,
			privateKey: existing.privateKey,
			installationId,
		};
		this.write(completed);
		return completed;
	}

	/** Remove the stored credential (revoke path for operators/scripts). */
	clear(): void {
		try {
			unlinkSync(this.filePath);
		} catch {
			// Absent file is already clear.
		}
	}

	private write(credential: StoredGitHubAppCredential): void {
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		// Write-then-rename so a crash mid-write never truncates the old
		// credential. The temp file sits beside the target so the rename
		// stays on one filesystem.
		const tempPath = `${this.filePath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(credential, null, "\t"), { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, this.filePath);
	}
}
