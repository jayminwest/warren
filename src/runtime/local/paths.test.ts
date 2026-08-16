import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalRunManifest, removeLocalRunManifest, writeLocalRunManifest } from "./manifest.ts";
import {
	localHomePath,
	localManifestPath,
	localSandboxId,
	localWorkspacePath,
	resolveLocalStateRoots,
} from "./paths.ts";

describe("resolveLocalStateRoots", () => {
	test("roots state under WARREN_DATA_DIR/local", () => {
		const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: "/state" });
		expect(roots.workspaces).toBe("/state/local/workspaces");
		expect(roots.homes).toBe("/state/local/homes");
		expect(roots.manifests).toBe("/state/local/manifests");
	});

	test("defaults to /data when WARREN_DATA_DIR is unset or blank", () => {
		expect(resolveLocalStateRoots({}).dataDir).toBe("/data");
		expect(resolveLocalStateRoots({ WARREN_DATA_DIR: "  " }).dataDir).toBe("/data");
	});

	test("derives per-sandbox paths deterministically", () => {
		const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: "/state" });
		expect(localSandboxId("run_1")).toBe("local-run_1");
		expect(localWorkspacePath(roots, "local-run_1")).toBe("/state/local/workspaces/local-run_1");
		expect(localHomePath(roots, "local-run_1")).toBe("/state/local/homes/local-run_1");
		expect(localManifestPath(roots, "local-run_1")).toBe("/state/local/manifests/local-run_1.json");
	});
});

describe("local run manifest", () => {
	test("round-trips a written manifest and removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-manifest-"));
		try {
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dir });
			const manifest = {
				version: 1 as const,
				sandboxId: "local-run_1",
				runId: "run_1",
				branch: "warren/run_1",
				workspacePath: join(dir, "ws"),
				homePath: join(dir, "home"),
				source: { kind: "clone" as const, branch: "warren/run_1" },
				createdAt: new Date().toISOString(),
			};
			await writeLocalRunManifest(roots, manifest);
			const read = await readLocalRunManifest(roots, "local-run_1");
			expect(read?.workspacePath).toBe(manifest.workspacePath);
			expect(read?.source.kind).toBe("clone");
			await removeLocalRunManifest(roots, "local-run_1");
			expect(await readLocalRunManifest(roots, "local-run_1")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads null for a missing or malformed manifest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-manifest-"));
		try {
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dir });
			expect(await readLocalRunManifest(roots, "local-ghost")).toBeNull();
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(roots.manifests, { recursive: true });
			await writeFile(localManifestPath(roots, "local-bad"), "not json");
			expect(await readLocalRunManifest(roots, "local-bad")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
