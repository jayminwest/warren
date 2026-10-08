/**
 * Proves the GritQL plugins fire through the real biome.jsonc overrides
 * (warren-6772): the test copies biome.jsonc and .biome/plugins into a
 * temp tree, writes fixture .tsx files, and lints them with biome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { countPluginHits, parseAllowlist } from "./check-ui-raw-elements.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BIOME_BIN = resolve(REPO_ROOT, "node_modules/.bin/biome");

const RAW_BUTTON = `export function Fixture() {\n\treturn <button type="button">go</button>;\n}\n`;
const RAW_FIELDS = `export function Fixture() {\n\treturn (\n\t\t<form>\n\t\t\t<input />\n\t\t\t<select />\n\t\t\t<textarea />\n\t\t</form>\n\t);\n}\n`;
const PRIMITIVE = `import { Button } from "@/components/ui/button.tsx";\n\nexport function Fixture() {\n\treturn <Button type="button">go</Button>;\n}\n`;
const CSS_VAR_STYLE = `export function Fixture({ h }: { h: string }) {\n\treturn <div className="h-(--bar-h)" style={{ "--bar-h": h }} />;\n}\n`;
const RAW_STYLE = `export function Fixture() {\n\treturn <div style={{ height: 4 }} />;\n}\n`;
const MIXED_STYLE = `export function Fixture() {\n\treturn <div style={{ "--bar-h": "4px", color: "red" }} />;\n}\n`;

function firstGrandfathered(): string {
	const raw = JSON.parse(
		readFileSync(resolve(REPO_ROOT, "scripts/ui-raw-elements-allowlist.json"), "utf8"),
	) as unknown;
	const { allowlist } = parseAllowlist(raw);
	const rawOnly = Object.keys(allowlist["no-raw-form-elements"]).find(
		(p) => allowlist["no-inline-style"][p] === undefined,
	);
	if (rawOnly === undefined) throw new Error("no raw-form-only grandfathered file to probe");
	return rawOnly;
}

const FIXTURES: Record<string, string> = {
	"src/ui/src/pages/grit-raw-button.tsx": RAW_BUTTON,
	"src/ui/src/pages/grit-raw-fields.tsx": RAW_FIELDS,
	"src/ui/src/components/ui/grit-raw-button.tsx": RAW_BUTTON,
	"src/ui/src/components/ui/grit-raw-style.tsx": RAW_STYLE,
	"src/ui/src/pages/grit-primitive.tsx": PRIMITIVE,
	"src/ui/src/pages/grit-css-var-style.tsx": CSS_VAR_STYLE,
	"src/ui/src/pages/grit-raw-style.tsx": RAW_STYLE,
	"src/ui/src/pages/grit-mixed-style.tsx": MIXED_STYLE,
};

let dir = "";
let counts = new Map<string, number>();
let grandfathered = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "grit-plugins-"));
	cpSync(resolve(REPO_ROOT, "biome.jsonc"), join(dir, "biome.jsonc"));
	cpSync(resolve(REPO_ROOT, ".biome"), join(dir, ".biome"), { recursive: true });
	grandfathered = firstGrandfathered();
	const files = { ...FIXTURES, [grandfathered]: RAW_BUTTON };
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), body);
	}
	const proc = Bun.spawnSync(
		[BIOME_BIN, "lint", "--reporter=json", "--max-diagnostics=none", ...Object.keys(files)],
		{ cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
	);
	counts = countPluginHits(proc.stdout.toString());
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("no-raw-form-elements.grit", () => {
	test("flags a raw <button> outside components/ui", () => {
		expect(counts.get("src/ui/src/pages/grit-raw-button.tsx")).toBe(1);
	});

	test("flags raw <input>, <select>, and <textarea>", () => {
		expect(counts.get("src/ui/src/pages/grit-raw-fields.tsx")).toBe(3);
	});

	test("leaves components/ui and the primitives alone", () => {
		expect(counts.get("src/ui/src/components/ui/grit-raw-button.tsx")).toBeUndefined();
		expect(counts.get("src/ui/src/pages/grit-primitive.tsx")).toBeUndefined();
	});

	test("skips files grandfathered in the allowlist", () => {
		expect(counts.get(grandfathered)).toBeUndefined();
	});
});

describe("no-inline-style.grit", () => {
	test("allows a CSS-variable-only style object", () => {
		expect(counts.get("src/ui/src/pages/grit-css-var-style.tsx")).toBeUndefined();
	});

	test("flags a plain style object and a mixed one", () => {
		expect(counts.get("src/ui/src/pages/grit-raw-style.tsx")).toBe(1);
		expect(counts.get("src/ui/src/pages/grit-mixed-style.tsx")).toBe(1);
	});

	test("leaves components/ui alone", () => {
		expect(counts.get("src/ui/src/components/ui/grit-raw-style.tsx")).toBeUndefined();
	});
});
