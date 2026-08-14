/**
 * Command generalization + categorization for the behavior-analytics
 * command mining (warren-8976 / pl-ad0f step 7; split out of
 * `command-mining.ts` under the 500-line file budget when warren-c116
 * added the per-runtime shape resolution).
 *
 * "Generalization" collapses a raw command string to a stable
 * signature — the binary plus (for multi-subcommand CLIs like
 * `git`/`gh`/`sd`/`ml`/`bun`) its first subcommand — so
 * `bun run check:all` and `bun check:all` rank together and
 * per-invocation arguments don't fragment the ranking. `categorize`
 * buckets a generalized signature for the command-category bar chart,
 * and `isOsEcoCommand` flags warren's own workflow tooling so the
 * dashboard can highlight how much of a run is spent driving it.
 *
 * Pure and dependency-free; the aggregator in `command-mining.ts`
 * re-exports these so existing import sites keep working.
 */

export type CommandCategory =
	| "os-eco"
	| "vcs"
	| "package"
	| "build"
	| "test"
	| "filesystem"
	| "network"
	| "other";

/** CLIs whose first subcommand is part of the generalized signature. */
const MULTI_SUBCOMMAND = new Set([
	"git",
	"gh",
	"sd",
	"ml",
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"docker",
	"kubectl",
	"go",
]);
const FS_BINS = new Set([
	"cat",
	"ls",
	"grep",
	"rg",
	"find",
	"sed",
	"awk",
	"head",
	"tail",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"touch",
	"echo",
	"chmod",
	"wc",
	"sort",
	"uniq",
	"tee",
	"cd",
	"pwd",
	"tree",
	"stat",
	"diff",
]);
const NET_BINS = new Set(["curl", "wget", "ping", "ssh", "scp", "nc", "dig"]);
const PKG_SUBS = new Set(["install", "add", "remove", "ci", "uninstall", "update"]);
const PKG_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Collapse a raw command string to a stable signature, or null when it carries
 * no runnable binary. `cd x && bun test` → `bun test` (the trailing `&&`
 * segment); leading `sudo` / `VAR=val` prefixes and flags are stripped.
 */
export function generalizeCommand(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	// Use the last &&-joined segment so `cd dir && bun test` mines `bun test`.
	const segments = trimmed
		.split("&&")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	const segment = segments[segments.length - 1] ?? trimmed;
	const tokens = segment.split(/\s+/).filter((t) => t !== "");
	let i = 0;
	while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "") || tokens[i] === "sudo")) {
		i += 1;
	}
	const binToken = tokens[i];
	if (binToken === undefined) return null;
	const base = basename(binToken);
	if (base === "") return null;
	if (!MULTI_SUBCOMMAND.has(base)) return base;
	const rest = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
	if (base === "bun") return generalizeBun(rest);
	const sub = rest[0];
	return sub === undefined ? base : `${base} ${sub}`;
}

/**
 * Bun's own subcommands, which must not be collapsed into the
 * `bun run <script>` family — `bun install` is package management, not a
 * user script named `install`. `run` and `test` are handled separately.
 */
const BUN_SUBCOMMANDS = new Set(
	"install i add a remove rm update outdated link unlink pm x create init build upgrade publish patch audit why exec repl".split(
		" ",
	),
);

/**
 * `bun` / `bun run` normalize to the same `bun run <script>` family, but bun's
 * own subcommands (`bun install`, `bun add`, …) keep their `bun <sub>` shape
 * rather than masquerading as a run script.
 */
function generalizeBun(rest: readonly string[]): string {
	const first = rest[0];
	if (first === undefined) return "bun";
	if (first !== "run" && first !== "test" && BUN_SUBCOMMANDS.has(first)) {
		return `bun ${first}`;
	}
	const args = first === "run" ? rest.slice(1) : rest;
	const script = args[0];
	if (script === undefined) return "bun";
	if (script === "test") return "bun test";
	return `bun run ${script}`;
}

export function isOsEcoCommand(generalized: string): boolean {
	const bin = generalized.split(" ")[0] ?? "";
	if (bin === "ml" || bin === "sd" || bin === "gh") return true;
	return generalized.startsWith("bun run check:");
}

// True when any token's `:`-delimited segments exactly match `segment`, so
// `test:unit`/`lint:test` match `test` while `latest` does not (warren-1f19).
function hasSegment(parts: readonly string[], segment: string): boolean {
	return parts.some((part) => part.split(":").includes(segment));
}

export function categorize(generalized: string): CommandCategory {
	if (isOsEcoCommand(generalized)) return "os-eco";
	const parts = generalized.split(" ");
	const bin = parts[0] ?? "";
	if (bin === "git") return "vcs";
	if (PKG_MANAGERS.has(bin)) {
		// Token- and segment-precise matching: `latest`/`rebuild` must not match
		// `test`/`build` (warren-d4d5), while colon-namespaced scripts like
		// `test:unit`/`build:ui` bucket by their matching segment (warren-1f19).
		if (hasSegment(parts, "test")) return "test";
		if (PKG_SUBS.has(parts[1] ?? "")) return "package";
		if (hasSegment(parts, "build")) return "build";
		return "other";
	}
	if (["tsc", "vite", "make", "cargo", "tsup", "esbuild", "webpack"].includes(bin)) return "build";
	if (["vitest", "jest", "mocha", "pytest"].includes(bin)) return "test";
	if (FS_BINS.has(bin)) return "filesystem";
	if (NET_BINS.has(bin)) return "network";
	return "other";
}
