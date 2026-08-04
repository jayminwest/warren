import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generate, renderMarkdown } from "./generate-cli-reference.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("generate-cli-reference", () => {
	test("docs/cli-reference.md is in sync with the CLI command definitions", () => {
		const { content } = generate();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/cli-reference.md"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("extracts a healthy number of commands from the real program", () => {
		const { commands } = generate();
		expect(commands.length).toBeGreaterThanOrEqual(15);
		const names = new Set(commands.map((c) => c.name));
		for (const canonical of ["run", "plan run", "login", "prime", "serve", "show", "wait"]) {
			expect(names.has(canonical)).toBe(true);
		}
	});

	test("renderMarkdown produces an AUTO-GENERATED banner and command count", () => {
		const md = renderMarkdown(
			[{ flags: "--output <mode>", description: "global output mode", mandatory: false }],
			[
				{
					name: "run",
					description: "dispatch a run",
					usage: "[options] <agent> <project>",
					arguments: [
						{ name: "agent", required: true, variadic: false, description: "agent name" },
					],
					options: [
						{
							flags: "-p, --prompt <text>",
							description: "prompt text",
							mandatory: true,
						},
					],
					isGroup: false,
				},
			],
		);
		expect(md).toContain("AUTO-GENERATED");
		expect(md).toContain("Total commands: **1**.");
		expect(md).toContain("### `warren run`");
		expect(md).toContain("warren run [options] <agent> <project>");
		expect(md).toContain("| `<agent>` | yes | agent name |");
		expect(md).toContain("| `-p, --prompt <text>` | yes |  | prompt text |");
		expect(md).toContain("| `--output <mode>` | global output mode |");
	});

	test("renderMarkdown escapes pipe characters inside descriptions", () => {
		const md = renderMarkdown(
			[{ flags: "--output <mode>", description: "mode: ndjson|json|pretty", mandatory: false }],
			[
				{
					name: "plan list",
					description: "list plan-runs",
					usage: "[options]",
					arguments: [],
					options: [
						{
							flags: "--state <state>",
							description: "queued|running|succeeded",
							mandatory: false,
							defaultValue: "ndjson",
						},
					],
					isGroup: false,
				},
			],
		);
		expect(md).toContain("ndjson\\|json\\|pretty");
		expect(md).toContain("queued\\|running\\|succeeded");
		expect(md).toContain('`"ndjson"`');
	});

	test("renderMarkdown renders the exit-code table", () => {
		const md = renderMarkdown([], []);
		expect(md).toContain("## Exit codes");
		expect(md).toContain("| `2` | `usage-error` |");
		expect(md).toContain("| `130` | `sigint-detach` |");
	});

	test("renderMarkdown annotates command groups", () => {
		const md = renderMarkdown(
			[],
			[
				{
					name: "plan",
					description: "plan-run tools",
					usage: "[options] [command]",
					arguments: [],
					options: [],
					isGroup: true,
				},
			],
		);
		expect(md).toContain("_Command group — see the subcommands below._");
	});
});
