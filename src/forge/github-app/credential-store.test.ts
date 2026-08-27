import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APP_CRED_STORE_ENV,
	GITHUB_APP_CREDENTIAL_FILE,
	GitHubAppCredentialStore,
	isCompleteCredential,
	resolveAppCredStoreEnabled,
} from "./credential-store.ts";

function tmpStore(): GitHubAppCredentialStore {
	const dir = mkdtempSync(join(tmpdir(), "warren-appcred-"));
	return new GitHubAppCredentialStore(join(dir, GITHUB_APP_CREDENTIAL_FILE));
}

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

describe("resolveAppCredStoreEnabled", () => {
	test("defaults OFF when the knob is unset or blank", () => {
		expect(resolveAppCredStoreEnabled({})).toBe(false);
		expect(resolveAppCredStoreEnabled({ [APP_CRED_STORE_ENV]: "  " })).toBe(false);
	});

	test("arms on data-dir", () => {
		expect(resolveAppCredStoreEnabled({ [APP_CRED_STORE_ENV]: "data-dir" })).toBe(true);
	});

	test("throws on an unrecognized value instead of silently defaulting", () => {
		expect(() => resolveAppCredStoreEnabled({ [APP_CRED_STORE_ENV]: "yes" })).toThrow();
	});

	test("refuses the store on a WARREN_AUTH=public instance", () => {
		expect(() =>
			resolveAppCredStoreEnabled({ [APP_CRED_STORE_ENV]: "data-dir", WARREN_AUTH: "public" }),
		).toThrow(/public/);
	});
});

describe("GitHubAppCredentialStore", () => {
	test("reads null when nothing is stored", () => {
		const store = tmpStore();
		expect(store.read()).toBeNull();
	});

	test("storeApp persists the App half with file mode 0600 and dir 0700", () => {
		const store = tmpStore();
		store.storeApp("4523930", PEM);
		expect(store.read()).toEqual({ appId: "4523930", privateKey: PEM });
		const fileMode = statSync(store.path).mode & 0o777;
		expect(fileMode).toBe(0o600);
		const dirMode = statSync(join(store.path, "..")).mode & 0o777;
		// mkdtemp's parent is 0700 already; the store must not widen it.
		expect(dirMode).toBe(0o700);
	});

	test("completeInstallation fills the triple and returns it", () => {
		const store = tmpStore();
		store.storeApp("4523930", PEM);
		const completed = store.completeInstallation("99123");
		expect(completed).toEqual({ appId: "4523930", privateKey: PEM, installationId: "99123" });
		expect(store.read()?.installationId).toBe("99123");
	});

	test("completeInstallation returns null with no stored App", () => {
		const store = tmpStore();
		expect(store.completeInstallation("99123")).toBeNull();
	});

	test("re-registration overwrites and drops the stale installation id", () => {
		const store = tmpStore();
		store.storeApp("1", PEM);
		store.completeInstallation("10");
		store.storeApp("2", "-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----");
		expect(store.read()).toEqual({
			appId: "2",
			privateKey: "-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----",
		});
	});

	test("re-registration keeps the installation id for the SAME app id", () => {
		const store = tmpStore();
		store.storeApp("1", PEM);
		store.completeInstallation("10");
		store.storeApp("1", PEM);
		expect(store.read()?.installationId).toBe("10");
	});

	test("isCompleteCredential distinguishes partial from complete triples", () => {
		expect(isCompleteCredential(null)).toBe(false);
		expect(isCompleteCredential({ appId: "1", privateKey: PEM })).toBe(false);
		expect(isCompleteCredential({ appId: "1", privateKey: PEM, installationId: "2" })).toBe(true);
		expect(isCompleteCredential({ appId: "1", privateKey: PEM, installationId: "" })).toBe(false);
	});

	test("clear removes the stored credential", () => {
		const store = tmpStore();
		store.storeApp("1", PEM);
		store.clear();
		expect(store.read()).toBeNull();
	});

	test("a corrupt file reads as null, not a throw", () => {
		const store = tmpStore();
		store.storeApp("1", PEM);
		writeFileSync(store.path, "{not json", { mode: 0o600 });
		expect(store.read()).toBeNull();
	});
});
