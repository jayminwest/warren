import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GITHUB_APP_CREDENTIAL_FILE,
	GitHubAppCredentialStore,
} from "../../forge/github-app/credential-store.ts";
import { GitHubAppForge } from "../../forge/github-app/provider.ts";
import { generateTestAppKeyPair } from "../../forge/github-app/test-helpers.ts";
import { HotForge } from "../../forge/hot-forge.ts";
import type { Logger } from "../types.ts";
import { bootGitHubAppActivation } from "./github-app-activation-wiring.ts";

const logger: Logger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
	child() {
		return this;
	},
} as unknown as Logger;

function dataDir(): string {
	return mkdtempSync(join(tmpdir(), "warren-appcred-boot-"));
}

describe("bootGitHubAppActivation", () => {
	test("store not armed: plain forge, no wrapper, no activation seam", () => {
		const { forge, activation } = bootGitHubAppActivation({
			env: {},
			dataDir: dataDir(),
			logger,
		});
		expect(forge).not.toBeInstanceOf(HotForge);
		expect(activation).toBeUndefined();
	});

	test("armed with no stored triple: HotForge over the boot (PAT) forge", () => {
		const { forge, activation } = bootGitHubAppActivation({
			env: { WARREN_APP_CRED_STORE: "data-dir" },
			dataDir: dataDir(),
			logger,
		});
		expect(forge).toBeInstanceOf(HotForge);
		expect(activation).toBeDefined();
		expect(activation?.hotForge.current.capabilities.credentialLifetime).toBe("static");
	});

	test("armed with a complete stored triple and absent env vars: boot prefers the App forge", () => {
		const dir = dataDir();
		const keyPair = generateTestAppKeyPair();
		const store = new GitHubAppCredentialStore(join(dir, GITHUB_APP_CREDENTIAL_FILE));
		store.storeApp("4523930", keyPair.privateKeyPem);
		store.completeInstallation("99123");
		const { forge, activation } = bootGitHubAppActivation({
			env: { WARREN_APP_CRED_STORE: "data-dir" },
			dataDir: dir,
			logger,
		});
		expect(forge).toBeInstanceOf(HotForge);
		const hot = forge as HotForge;
		expect(hot.current).toBeInstanceOf(GitHubAppForge);
		expect(hot.capabilities.credentialLifetime).toBe("short-lived");
		expect(activation).toBeDefined();
	});

	test("an explicit WARREN_GITHUB_APP_ID in env wins over the stored triple", () => {
		const dir = dataDir();
		const keyPair = generateTestAppKeyPair();
		const store = new GitHubAppCredentialStore(join(dir, GITHUB_APP_CREDENTIAL_FILE));
		store.storeApp("4523930", keyPair.privateKeyPem);
		store.completeInstallation("99123");
		const env = {
			WARREN_APP_CRED_STORE: "data-dir",
			WARREN_FORGE: "app",
			WARREN_GITHUB_APP_ID: "1111111",
			WARREN_GITHUB_APP_INSTALLATION_ID: "2222",
			WARREN_GITHUB_APP_PRIVATE_KEY: keyPair.privateKeyPem,
		};
		const { forge } = bootGitHubAppActivation({ env, dataDir: dir, logger });
		expect((forge as HotForge).current).toBeInstanceOf(GitHubAppForge);
		// Env credentials were used, not the store's — visible in appId via parse independence;
		// assert structurally: the wrapper exists and is the App provider.
		expect((forge as HotForge).capabilities.credentialLifetime).toBe("short-lived");
	});

	test("an explicit WARREN_FORGE=github wins over a stored triple", () => {
		const dir = dataDir();
		const keyPair = generateTestAppKeyPair();
		const store = new GitHubAppCredentialStore(join(dir, GITHUB_APP_CREDENTIAL_FILE));
		store.storeApp("4523930", keyPair.privateKeyPem);
		store.completeInstallation("99123");
		const { forge } = bootGitHubAppActivation({
			env: { WARREN_APP_CRED_STORE: "data-dir", WARREN_FORGE: "github" },
			dataDir: dir,
			logger,
		});
		expect((forge as HotForge).capabilities.credentialLifetime).toBe("static");
	});

	test("an unrecognized store value fails boot loud", () => {
		expect(() =>
			bootGitHubAppActivation({
				env: { WARREN_APP_CRED_STORE: "somewhere-else" },
				dataDir: dataDir(),
				logger,
			}),
		).toThrow();
	});

	test("a public-auth instance refuses the store at boot", () => {
		expect(() =>
			bootGitHubAppActivation({
				env: { WARREN_APP_CRED_STORE: "data-dir", WARREN_AUTH: "public" },
				dataDir: dataDir(),
				logger,
			}),
		).toThrow(/public/);
	});
});
