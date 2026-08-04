import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import type { WarrenClient } from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runConfigMigrate } from "./config-migrate.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env: {},
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

describe("runConfigMigrate (--cwd mode)", () => {
	// warren-97a2: deps are a WarrenClient now; --cwd mode never touches it.
	const client = {} as WarrenClient;
	let tmp: string;
	let warrenDir: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "warren-config-migrate-"));
		warrenDir = join(tmp, ".warren");
		await mkdir(warrenDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	test("converts a simple defaults.json into config.yaml; no preview hoist", async () => {
		await writeFile(
			join(warrenDir, "defaults.json"),
			JSON.stringify({ defaultRole: "claude-code", defaultBranch: "main" }, null, 2),
		);
		const { context, out } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);

		const stdout = JSON.parse(out.join(""));
		expect(stdout.ok).toBe(true);
		expect(stdout.migrated.previewHoisted).toBe(false);
		expect(stdout.migrated.written).toEqual([".warren/config.yaml"]);
		expect(stdout.migrated.removed).toBe(".warren/defaults.json");

		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(false);
		const configBody = await readFile(join(warrenDir, "config.yaml"), "utf8");
		expect(configBody.startsWith("# .warren/config.yaml")).toBe(true);
		expect(load(configBody)).toEqual({
			defaultRole: "claude-code",
			defaultBranch: "main",
		});
		expect(existsSync(join(warrenDir, "preview.yaml"))).toBe(false);
	});

	test("hoists a preview block into preview.yaml when present", async () => {
		await writeFile(
			join(warrenDir, "defaults.json"),
			JSON.stringify(
				{
					defaultRole: "claude-code",
					preview: {
						type: "server",
						command: "bun run dev",
						port: 3000,
						readiness_path: "/healthz",
					},
				},
				null,
				2,
			),
		);
		const { context, out } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);

		const stdout = JSON.parse(out.join(""));
		expect(stdout.migrated.previewHoisted).toBe(true);
		expect(stdout.migrated.written).toEqual([".warren/config.yaml", ".warren/preview.yaml"]);

		const configBody = await readFile(join(warrenDir, "config.yaml"), "utf8");
		expect(load(configBody)).toEqual({ defaultRole: "claude-code" });

		const previewBody = await readFile(join(warrenDir, "preview.yaml"), "utf8");
		expect(load(previewBody)).toEqual({
			type: "server",
			command: "bun run dev",
			port: 3000,
			readiness_path: "/healthz",
		});

		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(false);
	});

	test("empty defaults.json produces an empty config.yaml and no preview hoist", async () => {
		await writeFile(join(warrenDir, "defaults.json"), "{}\n");
		const { context, out } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);

		const stdout = JSON.parse(out.join(""));
		expect(stdout.migrated.previewHoisted).toBe(false);

		const configBody = await readFile(join(warrenDir, "config.yaml"), "utf8");
		expect(load(configBody)).toEqual({});
	});

	test("refuses to overwrite an existing config.yaml", async () => {
		await writeFile(join(warrenDir, "defaults.json"), JSON.stringify({ defaultBranch: "main" }));
		await writeFile(join(warrenDir, "config.yaml"), "defaultBranch: hand-written\n");
		const { context, err } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("refusing to overwrite");
		// defaults.json untouched on refusal so the operator can re-run.
		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(true);
	});

	test("refuses to overwrite an existing preview.yaml", async () => {
		await writeFile(
			join(warrenDir, "defaults.json"),
			JSON.stringify({ preview: { type: "server", command: "x", port: 1 } }),
		);
		await writeFile(join(warrenDir, "preview.yaml"), "type: server\ncommand: existing\nport: 1\n");
		const { context, err } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("refusing to overwrite");
		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(true);
	});

	test("malformed JSON aborts with exit 2 and leaves the file in place", async () => {
		await writeFile(join(warrenDir, "defaults.json"), "{not-valid");
		const { context, err } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toMatch(/failed to parse/);
		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(true);
		expect(existsSync(join(warrenDir, "config.yaml"))).toBe(false);
	});

	test("schema-invalid defaults aborts with exit 2 and leaves the file in place", async () => {
		await writeFile(join(warrenDir, "defaults.json"), JSON.stringify({ defaultRole: "" }));
		const { context, err } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toMatch(/schema validation/);
		expect(existsSync(join(warrenDir, "defaults.json"))).toBe(true);
	});

	test("no defaults.json present → exit 2 with a 'nothing to migrate' hint", async () => {
		const { context, err } = captureContext();
		const result = await runConfigMigrate(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toMatch(/nothing to migrate/);
	});
});
