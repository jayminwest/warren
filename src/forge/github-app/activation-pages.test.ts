import { describe, expect, test } from "bun:test";
import {
	renderActivatedPage,
	renderInstalledMissingIdPage,
	renderStoredCredentialsPage,
} from "./activation-pages.ts";

const REGISTRATION = {
	appId: 4523930,
	slug: "warren-stub-app",
	name: "warren-forge-abc123",
	htmlUrl: "https://github.com/apps/warren-stub-app",
	clientId: "Iv1.abc",
	clientSecret: "shh",
	pem: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
} as const;

const PATH = "/data/github-app-credentials.json";

describe("renderStoredCredentialsPage", () => {
	test("announces the stored credential and the install step, without env blocks or the PEM", () => {
		const html = renderStoredCredentialsPage(REGISTRATION, PATH);
		expect(html).toContain("warren stored the App credential");
		expect(html).toContain("4523930");
		expect(html).toContain(PATH);
		expect(html).toContain("0600");
		expect(html).toContain("installations/new");
		expect(html).not.toContain("WARREN_FORGE=app");
		expect(html).not.toContain("PRIVATE KEY");
	});

	test("names the revoke path", () => {
		const html = renderStoredCredentialsPage(REGISTRATION, PATH);
		expect(html).toContain("SECURITY.md");
	});
});

describe("renderActivatedPage", () => {
	test("says connected, names the stored triple, and links back to the UI", () => {
		const html = renderActivatedPage({
			appId: "4523930",
			installationId: "99123",
			credentialPath: PATH,
			uiUrl: "http://127.0.0.1:8377/",
		});
		expect(html).toContain("Connected");
		expect(html).toContain("active now");
		expect(html).toContain("99123");
		expect(html).toContain('href="http://127.0.0.1:8377/"');
		expect(html).not.toContain("PRIVATE KEY");
	});
});

describe("renderInstalledMissingIdPage", () => {
	test("explains the partial state and the manual completion path", () => {
		const html = renderInstalledMissingIdPage(PATH);
		expect(html).toContain("Installation id not on this URL");
		expect(html).toContain("installation_id");
		expect(html).toContain(PATH);
		expect(html).toContain("NOT active");
	});
});
