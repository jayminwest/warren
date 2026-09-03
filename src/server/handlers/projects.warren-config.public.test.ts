import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import type { DefaultsConfig, LoadedWarrenConfig } from "../../warren-config/index.ts";
import { DefaultsConfigSchema } from "../../warren-config/schema.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";
import { PUBLIC_PROJECT_FIELDS } from "./projects.ts";
import {
	PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS,
	PUBLIC_WARREN_CONFIG_FIELDS,
	REDACTED_WARREN_CONFIG_FIELDS,
} from "./projects.warren-config.ts";

/**
 * The public-projection half of `GET /projects/:id/warren-config`
 * (warren-b754): the classification is asserted as data (every key of
 * the envelope ∪ defaults lands in exactly one of the three lists) and
 * over the wire against a real server under `WARREN_AUTH=public`,
 * anonymously and with the operator token. The operator-envelope shape
 * itself is pinned in `projects.warren-config.test.ts`.
 *
 * Same proof shape as `public-projections.test.ts`, split out to keep
 * that file inside the 500-line budget (check:size).
 */

const TOKEN = "s3cret";

describe("warren-config field classification (warren-b754)", () => {
	test("every envelope + defaults key is classified exactly once", () => {
		// The envelope keys are enumerated literally (load.ts has no schema
		// shape to derive them from — `satisfies` catches a rename) while
		// the defaults keys derive from the zod schema, so a block added to
		// `DefaultsConfigSchema` fails here until it is classified.
		const envelopeKeys = [
			"triggers",
			"defaults",
			"prTemplate",
			"sourceFile",
			"errors",
			"warnings",
		] as const satisfies readonly (keyof LoadedWarrenConfig)[];
		const defaultsKeys = Object.keys(DefaultsConfigSchema.shape);
		const classified: string[] = [
			...PUBLIC_WARREN_CONFIG_FIELDS,
			...PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS,
			...REDACTED_WARREN_CONFIG_FIELDS,
		];
		expect([...classified].sort()).toEqual(
			[...new Set<string>([...envelopeKeys, ...defaultsKeys])].sort(),
		);
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("prompt text, the gate command and the spend cap are redacted defaults", () => {
		for (const dropped of ["defaultPrompt", "qualityGate", "maxCostUsd", "repoContext"] as const) {
			expect(REDACTED_WARREN_CONFIG_FIELDS).toContain(dropped);
		}
		for (const kept of ["triggers", "prTemplate", "errors"] as const) {
			expect(REDACTED_WARREN_CONFIG_FIELDS).toContain(kept);
		}
		for (const kept of ["sourceFile", "warnings", "defaults"] as const) {
			expect(PUBLIC_WARREN_CONFIG_FIELDS).toContain(kept);
		}
	});

	test("the project pair still partitions ProjectRow beside it", () => {
		// Sanity anchor: the warren-config classification is recorded in
		// the same posture as the project pair it sits beside.
		expect(PUBLIC_PROJECT_FIELDS.length).toBeGreaterThan(0);
	});
});

describe("public projections over the wire — warren-config (warren-b754)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		handle = startServer(await depsFor(repos, new FakeProvider()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function get(path: string, token?: string): Promise<Record<string, unknown>> {
		const res = await fetch(
			`${base}${path}`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	test("anonymous body is the narrowed envelope; the operator body is unchanged", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-public-cfg-"));
		await mkdir(join(dir, ".warren"), { recursive: true });
		await writeFile(
			join(dir, ".warren", "config.yaml"),
			[
				"defaultRole: planner",
				"defaultBranch: main",
				"defaultProvider: anthropic",
				"defaultModel: opus",
				"runBranchPrefix: warren",
				"defaultPrompt: SECRET-PROMPT-TEXT",
				"qualityGate: bun run check:all",
				"maxCostUsd: 5",
				"",
			].join("\n"),
		);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/configured.git",
			localPath: dir,
			defaultBranch: "main",
		});

		const body = await get(`/projects/${project.id}/warren-config`);
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_WARREN_CONFIG_FIELDS].sort());
		const defaults = body.defaults as Record<string, unknown>;
		expect(Object.keys(defaults).sort()).toEqual([...PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS].sort());
		expect(defaults.defaultRole).toBe("planner");
		expect(defaults.maxCostUsd).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("SECRET-PROMPT-TEXT");

		const operatorBody = await get(`/projects/${project.id}/warren-config`, TOKEN);
		expect(Object.keys(operatorBody).sort()).toEqual(
			["defaults", "errors", "sourceFile", "triggers", "warnings"].sort(),
		);
		expect(JSON.stringify(operatorBody)).toContain("SECRET-PROMPT-TEXT");
		expect((operatorBody.defaults as DefaultsConfig).defaultPrompt).toBe("SECRET-PROMPT-TEXT");
	});
});
