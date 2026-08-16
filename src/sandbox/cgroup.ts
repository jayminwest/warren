/**
 * cgroup v2 resource enforcement for the Linux sandbox spawn path
 * (burrow-2083). Lifted from burrow's `src/provider/local/cgroup.ts`
 * (warren-5af7); the env knob, leaf prefix, and shim name are re-branded
 * to warren.
 *
 * bwrap is a namespace sandbox, not a resource controller — without this
 * module, `memoryLimitMb` / `cpuLimit` would be parsed into
 * `SandboxProfile` and never enforced, so one runaway toolchain inside a
 * sandbox could consume all host RAM and get warren itself OOM-killed
 * (observed on warren-deployed: kernel killed the largest bun process at
 * ~7.7GB RSS on an 8GB, zero-swap machine).
 *
 * Enforcement model: each sandbox gets its own delegated cgroup v2 leaf
 * (`<root>/warren-sb-<id>`) with `memory.max` (and `cpu.max` when
 * `cpuLimit` is set) written before exec. The spawn argv is wrapped in a
 * tiny `sh -c` shim that writes its own pid into `cgroup.procs` and then
 * `exec`s bwrap — same pid, so the whole bwrap tree lives inside the
 * limit from its first instruction (no post-spawn migration race). A
 * runaway is then OOM-killed *inside its own cgroup*: the run fails
 * cleanly and warren + the host survive.
 *
 * Graceful degradation: on hosts without a writable cgroup v2 tree
 * (macOS, non-delegated containers) `prepareSandboxCgroup` returns null
 * and the spawn proceeds unlimited.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Default `memory.max` applied on Linux when neither the profile nor
 * `WARREN_SANDBOX_MEMORY_LIMIT_MB` specifies a limit. Deliberately well
 * below typical host RAM (burrow-2083): an unconfigured sandbox must never
 * be able to take the host down. Operators running genuinely memory-hungry
 * workloads raise the profile limit (or the env var) instead of running
 * uncapped.
 */
export const DEFAULT_SANDBOX_MEMORY_LIMIT_MB = 4096;

/** Env knob: overrides the default when the profile has no limit. `0` disables the default cap. */
export const MEMORY_LIMIT_ENV = "WARREN_SANDBOX_MEMORY_LIMIT_MB";

const CPU_PERIOD_US = 100_000;

export interface SandboxCgroupLimits {
	memoryLimitMb?: number;
	cpuLimit?: number;
}

export interface SandboxCgroup {
	/** Absolute path of the per-sandbox cgroup directory. */
	dir: string;
	/** `<dir>/cgroup.procs` — the file the exec shim writes its pid into. */
	procsPath: string;
	/** True when the kernel OOM-killed a process inside this cgroup. */
	oomKilled(): boolean;
	/** Record the final oom_kill count and remove the cgroup dir. Idempotent. */
	cleanup(): void;
}

/**
 * Resolve the effective limits for a spawn. Precedence for memory:
 * explicit profile value > `WARREN_SANDBOX_MEMORY_LIMIT_MB` env > built-in
 * default. Returns null when nothing is enforceable (default disabled via
 * env `0` and no cpu limit).
 */
export function resolveSandboxLimits(
	profile: SandboxCgroupLimits,
	env: Record<string, string | undefined>,
): SandboxCgroupLimits | null {
	const out: SandboxCgroupLimits = {};
	const memoryLimitMb = resolveMemoryLimitMb(profile.memoryLimitMb, env[MEMORY_LIMIT_ENV]);
	if (memoryLimitMb !== undefined) out.memoryLimitMb = memoryLimitMb;
	if (profile.cpuLimit !== undefined) out.cpuLimit = profile.cpuLimit;
	return out.memoryLimitMb !== undefined || out.cpuLimit !== undefined ? out : null;
}

function resolveMemoryLimitMb(
	profileMb: number | undefined,
	envRaw: string | undefined,
): number | undefined {
	if (profileMb !== undefined) return profileMb;
	if (envRaw !== undefined && envRaw.trim() !== "") {
		const parsed = Number.parseInt(envRaw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
		if (parsed === 0) return undefined; // explicit opt-out of the default cap
	}
	return DEFAULT_SANDBOX_MEMORY_LIMIT_MB;
}

export interface PrepareSandboxCgroupOptions {
	/** cgroup v2 mount point. Defaults to `/sys/fs/cgroup`. */
	root?: string;
	/** Leaf name suffix (testing). Defaults to a random id. */
	id?: string;
}

/**
 * Create a per-sandbox cgroup leaf with the requested limits applied.
 * Returns null when the host can't enforce them (no cgroup v2, memory
 * controller unavailable, tree not writable) — callers spawn unlimited.
 */
export function prepareSandboxCgroup(
	limits: SandboxCgroupLimits,
	options: PrepareSandboxCgroupOptions = {},
): SandboxCgroup | null {
	const root = options.root ?? "/sys/fs/cgroup";
	const controllers = readControllers(root);
	if (controllers === null) return null; // not a cgroup v2 mount (or not Linux)
	const wantMemory = limits.memoryLimitMb !== undefined;
	const wantCpu = limits.cpuLimit !== undefined;
	if (wantMemory && !controllers.includes("memory")) return null;
	enableSubtreeControllers(root, controllers, wantMemory, wantCpu);

	const dir = join(root, `warren-sb-${options.id ?? randomUUID().slice(0, 8)}`);
	try {
		mkdirSync(dir);
	} catch {
		return null;
	}
	if (!applyLimits(dir, limits, wantMemory, wantCpu)) {
		try {
			rmdirSync(dir);
		} catch {
			// leave the empty leaf behind — harmless, reaped on host restart
		}
		return null;
	}
	return makeCgroupHandle(dir);
}

function readControllers(root: string): string | null {
	try {
		return readFileSync(join(root, "cgroup.controllers"), "utf8");
	} catch {
		return null;
	}
}

/**
 * Best-effort: enable the controllers for children. On the true root
 * cgroup (VMs, Fly Machines) this succeeds even with member processes;
 * inside a non-delegated container it may fail — the memory.max write
 * in applyLimits then fails too and we degrade to unlimited.
 */
function enableSubtreeControllers(
	root: string,
	controllers: string,
	wantMemory: boolean,
	wantCpu: boolean,
): void {
	const subtree = [
		wantMemory ? "+memory" : null,
		wantCpu && controllers.includes("cpu") ? "+cpu" : null,
	]
		.filter((s): s is string => s !== null)
		.join(" ");
	if (subtree.length === 0) return;
	try {
		writeFileSync(join(root, "cgroup.subtree_control"), subtree);
	} catch {
		// Already enabled, or not permitted — the limit writes decide.
	}
}

/** Write memory.max / cpu.max into the leaf. False means abandon the cgroup. */
function applyLimits(
	dir: string,
	limits: SandboxCgroupLimits,
	wantMemory: boolean,
	wantCpu: boolean,
): boolean {
	if (wantMemory && limits.memoryLimitMb !== undefined) {
		try {
			writeFileSync(join(dir, "memory.max"), String(limits.memoryLimitMb * 1024 * 1024));
		} catch {
			return false;
		}
	}
	if (wantCpu && limits.cpuLimit !== undefined) {
		const quota = Math.max(1000, Math.round(limits.cpuLimit * CPU_PERIOD_US));
		try {
			writeFileSync(join(dir, "cpu.max"), `${quota} ${CPU_PERIOD_US}`);
		} catch {
			// cpu is best-effort when memory is enforced; alone it's a hard fail
			if (!wantMemory) return false;
		}
	}
	return true;
}

function makeCgroupHandle(dir: string): SandboxCgroup {
	let cleaned = false;
	let oomAtCleanup = false;
	const readOom = (): boolean => readOomKillCount(dir) > 0;
	return {
		dir,
		procsPath: join(dir, "cgroup.procs"),
		oomKilled: () => (cleaned ? oomAtCleanup : readOom()),
		cleanup: () => {
			if (cleaned) return;
			oomAtCleanup = readOom();
			cleaned = true;
			try {
				rmdirSync(dir);
			} catch {
				// procs still draining or tree not removable — leave the leaf;
				// the limit keeps applying to any straggler, which is the
				// safe failure mode.
			}
		},
	};
}

/**
 * Wrap a spawn argv in a `sh -c` shim that enters the cgroup before
 * exec'ing the real command. `exec` keeps the pid, so the process is
 * inside the limit before the target binary runs a single instruction.
 * `procsPath` is generated by this module (no spaces/quotes), never
 * user input.
 */
export function wrapArgvForCgroup(argv: string[], procsPath: string): string[] {
	return ["/bin/sh", "-c", `echo $$ > ${procsPath} && exec "$@"`, "warren-cgexec", ...argv];
}

/** Parse `oom_kill <n>` out of `<dir>/memory.events`. 0 when unreadable. */
export function readOomKillCount(dir: string): number {
	let raw: string;
	try {
		raw = readFileSync(join(dir, "memory.events"), "utf8");
	} catch {
		return 0;
	}
	const match = raw.match(/^oom_kill (\d+)$/m);
	return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
}
