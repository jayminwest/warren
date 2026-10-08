import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makePrivateGitFixture, type PrivateGitFixture } from "./git-scope.test-helpers.ts";
import { type PrivateGitScope, privateGitScopeFor } from "./git-scope.ts";
import { DEFAULT_SEAL_LIMITS, sealCheckPrivateGitDir } from "./git-seal.ts";

describe("sealCheckPrivateGitDir (warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	let scope: PrivateGitScope;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
		scope = privateGitScopeFor({
			gitDir: fx.gitDir,
			hostGitDir: fx.hostGitDir,
			configSha256: fx.source.gitConfigSha256 ?? "",
		});
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("passes an untouched private dir with nothing sanitized", async () => {
		const report = await sealCheckPrivateGitDir(scope);
		expect(report.sanitized).toEqual([]);
		expect(report.entries).toBeGreaterThan(0);
	});

	test("breaks a hard link so host git cannot write through it", async () => {
		const outside = join(fx.root, "outside.txt");
		writeFileSync(outside, "keep\n");
		const inside = join(fx.gitDir, "logs", "linked");
		linkSync(outside, inside);
		const report = await sealCheckPrivateGitDir(scope);
		expect(report.sanitized).toEqual([inside]);
		expect(statSync(inside).nlink).toBe(1);
		appendFileSync(inside, "appended\n");
		expect(readFileSync(outside, "utf8")).toBe("keep\n");
		expect(readFileSync(inside, "utf8")).toBe("keep\nappended\n");
	});

	test("unlinks a FIFO", async () => {
		const fifo = join(fx.gitDir, "refs", "pipe");
		const res = Bun.spawnSync(["mkfifo", fifo]);
		expect(res.exitCode).toBe(0);
		const report = await sealCheckPrivateGitDir(scope);
		expect(report.sanitized).toEqual([fifo]);
		expect(existsSync(fifo)).toBe(false);
	});

	test("refuses a changed config", async () => {
		appendFileSync(join(fx.gitDir, "config"), "[core]\n\tfsmonitor = /tmp/x\n");
		await expect(sealCheckPrivateGitDir(scope)).rejects.toThrow(/config changed/);
	});

	test("refuses changed alternates", async () => {
		writeFileSync(
			join(fx.gitDir, "objects", "info", "alternates"),
			`${fx.siblingGitDir}/objects\n`,
		);
		await expect(sealCheckPrivateGitDir(scope)).rejects.toThrow(/alternates changed/);
	});

	test("fails closed past the entry cap", async () => {
		await expect(
			sealCheckPrivateGitDir(scope, { ...DEFAULT_SEAL_LIMITS, maxEntries: 3 }),
		).rejects.toThrow(/more than 3 entries/);
	});

	test("fails closed past the depth cap", async () => {
		mkdirSync(join(fx.gitDir, "a", "b", "c", "d"), { recursive: true });
		await expect(
			sealCheckPrivateGitDir(scope, { ...DEFAULT_SEAL_LIMITS, maxDepth: 2 }),
		).rejects.toThrow(/deeper than 2 levels/);
	});
});
