import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalRunManifest, writeLocalRunManifest } from "./manifest.ts";
import { resolveLocalStateRoots } from "./paths.ts";
import { createLocalWorkspaceDestroyer } from "./workspace-gc.ts";

async function tempDataDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "warren-gc-"));
}

describe("createLocalWorkspaceDestroyer", () => {
	test("reports already-gone when no manifest exists", async () => {
		const dir = await tempDataDir();
		try {
			const destroy = createLocalWorkspaceDestroyer({ WARREN_DATA_DIR: dir });
			expect(await destroy("local-ghost")).toEqual({ status: "already-gone" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("removes a clone-backed workspace, the HOME, and the manifest", async () => {
		const dir = await tempDataDir();
		try {
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dir });
			const workspacePath = join(dir, "ws");
			const homePath = join(dir, "home");
			await mkdir(workspacePath, { recursive: true });
			await mkdir(homePath, { recursive: true });
			await writeFile(join(workspacePath, "artifact.txt"), "x");
			await writeLocalRunManifest(roots, {
				version: 1,
				sandboxId: "local-run_1",
				runId: "run_1",
				branch: "warren/run_1",
				workspacePath,
				homePath,
				// clone kind keeps the removal git-free (plain rm -rf)
				source: { kind: "clone", branch: "warren/run_1" },
				createdAt: new Date().toISOString(),
			});
			const destroy = createLocalWorkspaceDestroyer({ WARREN_DATA_DIR: dir });
			const outcome = await destroy("local-run_1");
			expect(outcome).toEqual({
				status: "destroyed",
				archived: false,
				deletedEvents: 0,
				deletedRuns: 0,
			});
			expect(existsSync(workspacePath)).toBe(false);
			expect(existsSync(homePath)).toBe(false);
			expect(await readLocalRunManifest(roots, "local-run_1")).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a second destroy of the same id reports already-gone (idempotent)", async () => {
		const dir = await tempDataDir();
		try {
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dir });
			const workspacePath = join(dir, "ws");
			await mkdir(workspacePath, { recursive: true });
			await writeLocalRunManifest(roots, {
				version: 1,
				sandboxId: "local-run_2",
				runId: "run_2",
				branch: "warren/run_2",
				workspacePath,
				homePath: join(dir, "home2"),
				source: { kind: "clone", branch: "warren/run_2" },
				createdAt: new Date().toISOString(),
			});
			const destroy = createLocalWorkspaceDestroyer({ WARREN_DATA_DIR: dir });
			await destroy("local-run_2");
			expect(await destroy("local-run_2")).toEqual({ status: "already-gone" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
