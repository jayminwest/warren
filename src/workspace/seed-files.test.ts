import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";
import { resolveSeedFilePath, writeWorkspaceSeedFiles } from "./seed-files.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "warren-seed-files-"));
}

describe("writeWorkspaceSeedFiles", () => {
	test("writes nested files with parents created and default mode", async () => {
		const root = tempRoot();
		try {
			await writeWorkspaceSeedFiles(root, [
				{ path: ".warren/agent.json", contents: '{"name":"x"}' },
				{ path: ".seeds/issues.jsonl", contents: "{}\n" },
			]);
			expect(readFileSync(join(root, ".warren/agent.json"), "utf8")).toBe('{"name":"x"}');
			expect(readFileSync(join(root, ".seeds/issues.jsonl"), "utf8")).toBe("{}\n");
			expect(statSync(join(root, ".warren/agent.json")).mode & 0o777).toBe(0o644);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("decodes base64 contents and honors an explicit mode", async () => {
		const root = tempRoot();
		try {
			await writeWorkspaceSeedFiles(root, [
				{
					path: "bin/run.sh",
					contents: Buffer.from("#!/bin/sh\necho hi\n").toString("base64"),
					encoding: "base64",
					mode: 0o755,
				},
			]);
			expect(readFileSync(join(root, "bin/run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
			expect(statSync(join(root, "bin/run.sh")).mode & 0o777).toBe(0o755);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an absolute path before writing anything", async () => {
		const root = tempRoot();
		try {
			await expect(
				writeWorkspaceSeedFiles(root, [
					{ path: "ok.txt", contents: "x" },
					{ path: "/etc/passwd", contents: "x" },
				]),
			).rejects.toThrow(WorkspaceMaterializationError);
			// all-or-nothing: the valid entry was never written
			expect(() => statSync(join(root, "ok.txt"))).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects .. escapes and .git targets", async () => {
		const root = tempRoot();
		try {
			await expect(
				writeWorkspaceSeedFiles(root, [{ path: "../escape.txt", contents: "x" }]),
			).rejects.toThrow(/escapes the workspace/);
			await expect(
				writeWorkspaceSeedFiles(root, [{ path: ".git/config", contents: "x" }]),
			).rejects.toThrow(/\.git/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an unsupported encoding", async () => {
		const root = tempRoot();
		try {
			await expect(
				writeWorkspaceSeedFiles(root, [{ path: "a.txt", contents: "x", encoding: "rot13" }]),
			).rejects.toThrow(/unsupported encoding/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveSeedFilePath", () => {
	test("resolves a plain relative path under the root", () => {
		expect(resolveSeedFilePath("/ws", ".mulch/x.jsonl")).toBe("/ws/.mulch/x.jsonl");
	});
});
