/**
 * SandboxProfile construction for the in-process LocalProvider (warren-413d).
 *
 * Burrow built this inside `POST /burrows` from the project's `burrow.toml`,
 * a doctor run, and each runtime's `envPassthrough` declaration. With the
 * daemon off the spawn path, warren composes the profile itself from three
 * sources:
 *
 *   1. The neutral `RunSpec` — network intent, domain env, resources.
 *   2. The host clone's `burrow.toml` `[sandbox]` section — the same file
 *      burrow read (allowed_domains, read_only_paths, memory/cpu/timeout).
 *      Parsed here with a minimal line-based reader (warren only ever wrote
 *      these configs by hand; see `src/runs/burrow-config.ts` for the same
 *      posture). `RunSpec.resources` wins over the file when both speak.
 *   3. The warren-owned env allowlist (`resolveEnvPassthrough`) — the
 *      per-runtime host-env names forwarded into the sandbox, lifted from
 *      burrow's runtime registries (claude-code.ts / pi.ts). warren-fb8d
 *      formalizes this into a provider→env registry; until then this module
 *      is the single home.
 *
 * Toolchain paths make bare-name binaries (`claude`, `pi`, `git`, `bun`)
 * resolvable inside the bwrap sandbox: the production image installs every
 * agent under `/usr/local` (covered by bwrap's SYSTEM_RO_MOUNTS but NOT by
 * the `/usr/bin:/bin` PATH fallback), so each resolved binary's bin dir is
 * both mounted (when outside the system mounts, e.g. a dev-machine
 * `~/.bun/bin`) and prepended to PATH by `src/sandbox/env.ts`.
 */

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KNOWN_PROVIDER_NAMES, PROVIDER_ENV_REGISTRY } from "../../core/providers.ts";
import type { AcceptedRuntimeId } from "../../core/wire.ts";
import { WARREN_SANDBOX_GIT_ENV } from "../../sandbox/git-preflight.ts";
import type { SandboxProfile } from "../../sandbox/types.ts";
import type { MaterializedWorkspace } from "../../workspace/materialize.ts";
import type { RunSpec } from "../contract.ts";

/* -------------------------------------------------------------------------- */
/* Env passthrough (warren-owned allowlist; warren-fb8d formalizes)            */
/* -------------------------------------------------------------------------- */

/** claude-code's host-env allowlist — burrow's `CLAUDE_CODE_ENV_PASSTHROUGH`. */
export const CLAUDE_CODE_ENV_PASSTHROUGH: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
];

/** pi's base allowlist — burrow's `PI_ENV_PASSTHROUGH`. */
export const PI_ENV_PASSTHROUGH: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"EXA_API_KEY",
];

/**
 * pi's per-provider key delta (burrow's `PI_PROVIDER_ENV_KEYS`, burrow-6f3f):
 * when `frontmatter.provider` selects a non-anthropic provider, the matching
 * key(s) ride in addition to the anthropic base.
 *
 * Derived from the canonical `PROVIDER_ENV_REGISTRY` (warren-fb8d,
 * `src/core/providers.ts`) so the local/docker allowlist can never drift
 * behind the dispatch-time provider vocabulary again: warren-81e0 was
 * exactly that drift — the registry (and the K8s pod-env seam) knew
 * `openrouter`, this hand-maintained table did not, so a run dispatched
 * with `provider: openrouter` (e.g. via a project's `.warren/config.yaml`
 * `defaultProvider`) reached the sandbox without `OPENROUTER_API_KEY` and
 * pi died with "No API key found for openrouter" despite the operator
 * holding the key. Each entry is the provider's required `envKeys` plus
 * its `optionalEnvKeys` (base-URL overrides); `anthropic` is omitted
 * because the base allowlist already carries it.
 */
export const PI_PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
	KNOWN_PROVIDER_NAMES.filter((name) => name !== "anthropic").map((name) => {
		const registration = PROVIDER_ENV_REGISTRY[name];
		return [name, [...registration.envKeys, ...registration.optionalEnvKeys]];
	}),
);

/**
 * Resolve the host-env names forwarded into the sandbox for a run. Keyed off
 * the runtime id + the run's frontmatter (pi's provider override), matching
 * burrow's up-time (base) + dispatch-time (provider delta) union in one pass.
 */
export function resolveEnvPassthrough(
	runtimeId: AcceptedRuntimeId,
	frontmatter: Record<string, unknown> | undefined,
): string[] {
	if (runtimeId === "claude-code") return [...CLAUDE_CODE_ENV_PASSTHROUGH];
	if (runtimeId !== "pi") return [];
	const provider =
		typeof frontmatter?.provider === "string" ? frontmatter.provider.toLowerCase() : "";
	const extra = PI_PROVIDER_ENV_KEYS[provider];
	if (provider === "" || provider === "anthropic" || extra === undefined) {
		return [...PI_ENV_PASSTHROUGH];
	}
	return [...PI_ENV_PASSTHROUGH, ...extra];
}

/* -------------------------------------------------------------------------- */
/* Toolchain paths                                                             */
/* -------------------------------------------------------------------------- */

/** Prefixes bwrap already mounts read-only (src/sandbox/bwrap.ts SYSTEM_RO_MOUNTS). */
const SYSTEM_RO_PREFIXES = ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt"];

/** Binaries probed per runtime — the agent CLI plus the tools every run needs. */
const AGENT_BINARIES: Readonly<Record<string, readonly string[]>> = {
	"claude-code": ["claude"],
	pi: ["pi"],
};
const COMMON_BINARIES: readonly string[] = ["git", "bun", "node"];

function isUnderSystemMounts(path: string): boolean {
	return SYSTEM_RO_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Resolve one probed binary. `git` honors `WARREN_SANDBOX_GIT` (warren-1219):
 * the sandbox git preflight sets it when the PATH-resolved git fails inside
 * the sandbox but /usr/bin/git passes, so profile composition prefers the
 * binary that actually executes there. An operator may also pin it by hand.
 */
function resolveBinaryPath(name: string, which: (name: string) => string | null): string | null {
	if (name === "git") {
		const override = process.env[WARREN_SANDBOX_GIT_ENV];
		if (typeof override === "string" && override !== "") return override;
	}
	return which(name);
}

/**
 * Resolve the host paths the sandbox must mount + PATH-prepend so the agent's
 * bare-name argv resolves inside bwrap. For each probed binary: the bin dir
 * (the name's home) always contributes a PATH entry; when the resolved binary
 * (symlink target) escapes bwrap's system RO mounts, its directory is added
 * too so the target exists inside the sandbox. Missing binaries are skipped —
 * the spawn itself surfaces a clear ENOENT.
 *
 * The `git` entry honors `WARREN_SANDBOX_GIT` (warren-1219): the sandbox
 * git preflight sets it when the PATH-resolved git fails inside the sandbox
 * but /usr/bin/git passes, so profile composition prefers the binary that
 * actually executes there.
 */
export function resolveToolchainPaths(
	runtimeId: AcceptedRuntimeId,
	which: (name: string) => string | null = (name) => Bun.which(name),
	/**
	 * Host bun install root. Defaults to `$BUN_INSTALL` or `~/.bun`. Injected
	 * for tests; production uses the real host path so the sandbox can read
	 * bun-shebang CLI sources under `install/global/node_modules` (burrow-aa46)
	 * and so macOS seatbelt grants the same root (warren-bea7).
	 */
	hostBunInstall: string = defaultHostBunInstall(),
): string[] {
	const names = [...(AGENT_BINARIES[runtimeId] ?? []), ...COMMON_BINARIES];
	const dirs: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string): void => {
		if (dir === "" || dir === "." || seen.has(dir)) return;
		seen.add(dir);
		dirs.push(dir);
	};
	for (const name of names) {
		const found = resolveBinaryPath(name, which);
		if (found === null) continue;
		// The bin dir carries the NAME (a symlink or the binary itself). It always
		// lands on the profile: bwrap's nested --ro-bind over an already-mounted
		// system path is a no-op collision, and env.ts prepends it to PATH (the
		// /usr/bin:/bin fallback alone never finds /usr/local/bin installs).
		add(dirname(found));
		try {
			const target = realpathSync(found);
			if (!isUnderSystemMounts(target)) add(dirname(target));
		} catch {
			// unresolvable symlink — the name dir above is the best we can do
		}
	}
	// Bun global CLIs (sd, ml, …) are bun-shebang stubs under `<BUN_INSTALL>/bin`
	// that import their .ts sources from `install/global/node_modules`. Mount the
	// modules root whenever the install tree exists so those stubs resolve inside
	// the sandbox (burrow-aa46). Always mount the install root itself when present
	// so bun's getpwuid-based ~/.bun lookup (not $HOME) succeeds on macOS
	// (warren-bea7) and on Linux bwrap where host home is otherwise invisible.
	if (hostBunInstall !== "" && existsSync(hostBunInstall)) {
		add(hostBunInstall);
		const globalModules = join(hostBunInstall, "install/global/node_modules");
		if (existsSync(globalModules)) add(globalModules);
	}
	return dirs;
}

function defaultHostBunInstall(): string {
	const fromEnv = process.env.BUN_INSTALL;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".bun");
}

/* -------------------------------------------------------------------------- */
/* Project burrow.toml [sandbox]                                               */
/* -------------------------------------------------------------------------- */

export interface LocalSandboxConfig {
	readonly allowedDomains?: string[];
	readonly readOnlyPaths?: string[];
	readonly memoryLimitMb?: number;
	readonly cpuLimit?: number;
	readonly timeoutMs?: number;
}

/**
 * Read the host clone's `burrow.toml` `[sandbox]` section — the same file
 * burrow's `up` read for the profile. Line-based (posture of
 * `src/runs/burrow-config.ts`); a missing/unreadable file yields `{}`.
 */
export async function readLocalSandboxConfig(projectRoot: string): Promise<LocalSandboxConfig> {
	let body: string;
	try {
		body = await readFile(join(projectRoot, "burrow.toml"), "utf8");
	} catch {
		return {};
	}
	return parseSandboxSection(body);
}

/** Exported for tests — the pure `[sandbox]` reader. */
export function parseSandboxSection(body: string): LocalSandboxConfig {
	const out: LocalSandboxConfig = {};
	let inSandbox = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (line === "") continue;
		if (line.startsWith("[")) {
			inSandbox = line === "[sandbox]";
			continue;
		}
		if (!inSandbox) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		applySandboxKey(out, line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	return out;
}

/** Apply one `[sandbox]` key/value onto the accumulating config. */
function applySandboxKey(out: LocalSandboxConfig, key: string, value: string): void {
	const mutable = out as {
		-readonly [K in keyof LocalSandboxConfig]: LocalSandboxConfig[K];
	};
	if (key === "allowed_domains") mutable.allowedDomains = parseStringArray(value);
	else if (key === "read_only_paths") mutable.readOnlyPaths = parseStringArray(value);
	else if (key === "memory_limit_mb") mutable.memoryLimitMb = parsePositiveNumber(value);
	else if (key === "cpu_limit") mutable.cpuLimit = parsePositiveNumber(value);
	else if (key === "timeout_minutes") {
		const minutes = parsePositiveNumber(value);
		if (minutes !== undefined) mutable.timeoutMs = minutes * 60_000;
	}
}

function parseStringArray(value: string): string[] | undefined {
	if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
	const inner = value.slice(1, -1).trim();
	if (inner === "") return [];
	const items: string[] = [];
	for (const raw of inner.split(",")) {
		const item = raw.trim();
		const unquoted =
			(item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))
				? item.slice(1, -1)
				: undefined;
		if (unquoted === undefined) return undefined;
		items.push(unquoted);
	}
	return items;
}

function parsePositiveNumber(value: string): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Expand a leading `~` against the HOST home (burrow.toml read_only_paths). */
function expandHome(path: string, hostHome: string): string {
	if (path === "~") return hostHome;
	if (path.startsWith("~/")) return join(hostHome, path.slice(2));
	return path;
}

/* -------------------------------------------------------------------------- */
/* Profile assembly                                                            */
/* -------------------------------------------------------------------------- */

export interface BuildProfileInput {
	readonly spec: RunSpec;
	/** The composed sandbox env (domain env + provider plumbing). */
	readonly env: Record<string, string>;
	readonly workspace: MaterializedWorkspace;
	/** The run's private writable HOME host dir (already created). */
	readonly homePath: string;
	readonly frontmatter?: Record<string, unknown>;
	/** Test seam for `Bun.which`. */
	readonly which?: (name: string) => string | null;
}

/**
 * Compose the `SandboxProfile` for one local run. `resources` precedence:
 * per-run `spec.resources` > project `burrow.toml` (burrow's historical
 * source) — `projectResources` is K8s-only (pod shapes), so it is ignored here.
 */
export async function buildLocalSandboxProfile(input: BuildProfileInput): Promise<SandboxProfile> {
	const { spec, workspace } = input;
	const projectRoot = spec.hostClonePathHint ?? "";
	const toml = projectRoot === "" ? {} : await readLocalSandboxConfig(projectRoot);
	const hostHome = homedir();

	const readOnlyMounts = (toml.readOnlyPaths ?? [])
		.map((p) => expandHome(p, hostHome))
		.filter((p) => existsSync(p));

	const profile: SandboxProfile = {
		workspace: workspace.workspacePath,
		home: input.homePath,
		readOnlyMounts,
		network: spec.network,
		allowedDomains: toml.allowedDomains ?? [],
		envPassthrough: resolveEnvPassthrough(spec.runtimeId, input.frontmatter),
		setEnv: input.env,
		toolchainPaths: resolveToolchainPaths(spec.runtimeId, input.which),
		...(workspace.source.gitCommonDir !== undefined
			? { workspaceGitdir: workspace.source.gitCommonDir }
			: {}),
		// warren-fabb: per-project agent image override — consumed only by the
		// container spawn seams (docker); the bwrap profile builder ignores it.
		...(spec.agentImage !== undefined ? { agentImage: spec.agentImage } : {}),
		...(spec.timeoutMs !== undefined
			? { timeoutMs: spec.timeoutMs }
			: toml.timeoutMs !== undefined
				? { timeoutMs: toml.timeoutMs }
				: {}),
	};
	const memoryLimitMb = spec.resources?.memoryMiB ?? toml.memoryLimitMb;
	if (memoryLimitMb !== undefined) profile.memoryLimitMb = memoryLimitMb;
	const cpuMillicores = spec.resources?.cpuMillicores;
	if (cpuMillicores !== undefined) profile.cpuLimit = cpuMillicores / 1000;
	else if (toml.cpuLimit !== undefined) profile.cpuLimit = toml.cpuLimit;
	return profile;
}
