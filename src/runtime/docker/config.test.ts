import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DOCKER_AGENT_IMAGE,
	DOCKER_HOST_GATEWAY_NAME,
	resolveDockerConfig,
	rewriteLoopbackUrl,
} from "./config.ts";

describe("resolveDockerConfig", () => {
	test("defaults to the docker CLI and the pinned agent image", () => {
		const config = resolveDockerConfig({});
		expect(config.bin).toBe("docker");
		expect(config.image).toBe(DEFAULT_DOCKER_AGENT_IMAGE);
		expect(config.restrictedNetwork).toBeNull();
		expect(config.hostGatewayName).toBe(DOCKER_HOST_GATEWAY_NAME);
	});

	test("reads the operator overrides", () => {
		const config = resolveDockerConfig({
			WARREN_DOCKER_BIN: "/usr/local/bin/docker",
			WARREN_DOCKER_AGENT_IMAGE: "ghcr.io/acme/warren-agent:1.2.3",
			WARREN_DOCKER_RESTRICTED_NETWORK: "warren-restricted",
		});
		expect(config.bin).toBe("/usr/local/bin/docker");
		expect(config.image).toBe("ghcr.io/acme/warren-agent:1.2.3");
		expect(config.restrictedNetwork).toBe("warren-restricted");
	});

	test("treats blank overrides as unset", () => {
		const config = resolveDockerConfig({
			WARREN_DOCKER_BIN: "  ",
			WARREN_DOCKER_AGENT_IMAGE: "",
			WARREN_DOCKER_RESTRICTED_NETWORK: "   ",
		});
		expect(config.bin).toBe("docker");
		expect(config.image).toBe(DEFAULT_DOCKER_AGENT_IMAGE);
		expect(config.restrictedNetwork).toBeNull();
	});
});

describe("rewriteLoopbackUrl", () => {
	test("rewrites a loopback callback URL to the host gateway, keeping port and path", () => {
		expect(rewriteLoopbackUrl("http://127.0.0.1:8080/api", "host.docker.internal")).toBe(
			"http://host.docker.internal:8080/api",
		);
		expect(rewriteLoopbackUrl("http://localhost:9000", "host.docker.internal")).toBe(
			"http://host.docker.internal:9000/",
		);
	});

	test("leaves a non-loopback URL unchanged", () => {
		const url = "https://warren.example.com/api";
		expect(rewriteLoopbackUrl(url, "host.docker.internal")).toBe(url);
	});

	test("returns null for an unparseable URL", () => {
		expect(rewriteLoopbackUrl("not a url", "host.docker.internal")).toBeNull();
	});
});
