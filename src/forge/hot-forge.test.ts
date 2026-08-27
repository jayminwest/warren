import { describe, expect, test } from "bun:test";
import type { Forge } from "./contract.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { generateTestAppKeyPair, stubGitHubAppServer } from "./github-app/test-helpers.ts";
import { HotForge } from "./hot-forge.ts";

describe("HotForge", () => {
	test("delegates every call to the boot forge", () => {
		const fake = new FakeForge();
		const hot = new HotForge(fake);
		expect(hot.current).toBe(fake);
		expect(hot.parseRepoRef("https://fake.invalid/o/r")).toEqual(
			fake.parseRepoRef("https://fake.invalid/o/r"),
		);
		expect(hot.activated).toBe(false);
	});

	test("activateApp swaps the delegate to a GitHubAppForge without a restart", () => {
		const keyPair = generateTestAppKeyPair();
		const boot: Forge = new FakeForge();
		const hot = new HotForge(boot);
		const previous = hot.activateApp(
			{ appId: "4523930", installationId: "99123", privateKey: keyPair.privateKeyPem },
			{ fetch: stubGitHubAppServer().fetch },
		);
		expect(previous).toBe(boot);
		expect(hot.activated).toBe(true);
		expect(hot.capabilities.credentialLifetime).toBe("short-lived");
		expect(hot.capabilities.checkRuns).toBe(true);
		// The next call through the SAME hot handle reaches the new forge —
		// the App forge owns the same github.com URL space as the PAT forge.
		const ref = hot.parseRepoRef("https://github.com/o/r.git");
		expect(ref).not.toBeNull();
		expect(ref?.forge).toBe("github");
	});

	test("activateApp fails loud on an unparseable private key", () => {
		const hot = new HotForge(new FakeForge());
		expect(() =>
			hot.activateApp({ appId: "1", installationId: "2", privateKey: "not a pem" }),
		).toThrow();
		// The boot forge still answers — a failed activation does not leave a half-swapped seam.
		expect(hot.activated).toBe(false);
	});
});
