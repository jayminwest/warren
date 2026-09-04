#!/usr/bin/env bun
/**
 * Extension gate guard (warren-c26c, GitHub #1182).
 *
 * `extensions/*` are standalone packages: own manifest, own lockfile, own
 * tsconfig. The root `tsconfig.json` and `biome.jsonc` exclude them on
 * purpose, because the seam is symmetric and core never compiles them.
 * Their TESTS still ride the root `bun test` sweep, so `check:coverage`
 * runs them. Each package's own `typecheck` and `lint` scripts ran
 * nowhere, and campaign-controller sat at 15 tsc errors on main while
 * every gate stayed green.
 *
 * This guard runs each extension's declared `typecheck` and `lint`
 * scripts, skips any it does not define, and fails when one is red. It
 * rides inside the `lint` gate because the 12-gate manifest is frozen. A
 * CI-only step would leave a local `bun run verify` green while an
 * extension is broken.
 *
 * An extension with no `node_modules` gets a frozen `bun install` first,
 * so a fresh clone's `bun run verify` does not fail on a resolution
 * error that `bun run ext:install` would have repaired. That repair is
 * exported as `ensureInstalled` because `check:coverage` needs the same
 * one before the root test sweep reaches `extensions/**` (warren-fe72).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The per-extension scripts this guard runs, in order, when declared. */
export const EXTENSION_GATES = ["typecheck", "lint"] as const;

export type ExtensionGate = (typeof EXTENSION_GATES)[number];

export interface ExtensionPlan {
	/** Absolute path of the extension package. */
	readonly dir: string;
	/** Path relative to the repo root, for messages. */
	readonly name: string;
	/** The gates the package declares in `scripts`, in run order. */
	readonly gates: readonly ExtensionGate[];
	/** Whether the package's dependencies are installed. */
	readonly installed: boolean;
	/** Whether the manifest declares any dependency to install. */
	readonly hasDependencies: boolean;
}

export interface GateResult {
	readonly name: string;
	readonly gate: ExtensionGate;
	readonly ok: boolean;
	/** Combined stdout + stderr, shown only on failure. */
	readonly output: string;
}

export interface CommandResult {
	readonly ok: boolean;
	readonly output: string;
}

/** The spawn seam, so tests can drive the runner without a real package. */
export type RunCommand = (cwd: string, argv: readonly string[]) => CommandResult;

export const defaultRunCommand: RunCommand = (cwd, argv) => {
	const proc = Bun.spawnSync([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
	const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
	return { ok: proc.exitCode === 0, output };
};

/** Every directory under `<root>/extensions` with a package.json, sorted. */
export function discoverExtensions(root: string = REPO_ROOT): ExtensionPlan[] {
	const extensionsDir = join(root, "extensions");
	if (!existsSync(extensionsDir)) return [];
	const plans: ExtensionPlan[] = [];
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(extensionsDir, entry.name);
		const manifestPath = join(dir, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const scripts = manifest.scripts ?? {};
		const declared =
			Object.keys(manifest.dependencies ?? {}).length +
			Object.keys(manifest.devDependencies ?? {}).length;
		plans.push({
			dir,
			name: relative(root, dir),
			gates: EXTENSION_GATES.filter((gate) => typeof scripts[gate] === "string"),
			installed: existsSync(join(dir, "node_modules")),
			hasDependencies: declared > 0,
		});
	}
	return plans.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Put a package's dependencies on disk when the manifest declares some
 * and `node_modules` is absent. A package that is already installed, or
 * that declares nothing, is left alone and reported ok.
 */
export function ensureInstalled(
	plan: ExtensionPlan,
	run: RunCommand = defaultRunCommand,
): CommandResult {
	if (plan.installed || !plan.hasDependencies) return { ok: true, output: "" };
	return run(plan.dir, ["bun", "install", "--frozen-lockfile"]);
}

/**
 * Run every declared gate of every plan. A missing install is repaired
 * first with a frozen install, and an install failure counts as a failed
 * first gate so the message points at the real cause.
 */
export function runExtensionGates(
	plans: readonly ExtensionPlan[],
	run: RunCommand = defaultRunCommand,
): GateResult[] {
	const results: GateResult[] = [];
	for (const plan of plans) {
		if (plan.gates.length === 0) continue;
		const install = ensureInstalled(plan, run);
		if (!install.ok) {
			const gate = plan.gates[0] ?? "typecheck";
			results.push({
				name: plan.name,
				gate,
				ok: false,
				output: `bun install --frozen-lockfile failed before ${gate} could run:\n${install.output}`,
			});
			continue;
		}
		for (const gate of plan.gates) {
			const result = run(plan.dir, ["bun", "run", gate]);
			results.push({ name: plan.name, gate, ok: result.ok, output: result.output });
		}
	}
	return results;
}

function main(): void {
	const plans = discoverExtensions();
	const results = runExtensionGates(plans);
	const failures = results.filter((r) => !r.ok);
	for (const failure of failures) {
		console.error(`${failure.name}: ${failure.gate} failed`);
		console.error(failure.output.trimEnd());
		console.error("");
	}
	if (failures.length > 0) {
		const hints = failures.map((f) => `  cd ${f.name} && bun run ${f.gate}`);
		console.error(`Extension gate failed. Re-run:\n${hints.join("\n")}`);
		process.exit(1);
	}
	console.log(
		`Extension gates ok (${results.length} gate runs across ${plans.length} extensions).`,
	);
}

if (import.meta.main) main();
