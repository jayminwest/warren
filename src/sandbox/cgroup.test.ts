import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SANDBOX_MEMORY_LIMIT_MB,
	MEMORY_LIMIT_ENV,
	prepareSandboxCgroup,
	readOomKillCount,
	resolveSandboxLimits,
	wrapArgvForCgroup,
} from "./cgroup.ts";

/** Build a fake cgroup v2 root: `cgroup.controllers` + `cgroup.subtree_control`. */
function fakeCgroupRoot(controllers = "cpuset cpu io memory pids"): string {
	const root = mkdtempSync(join(tmpdir(), "warren-cgroup-"));
	writeFileSync(join(root, "cgroup.controllers"), `${controllers}\n`);
	writeFileSync(join(root, "cgroup.subtree_control"), "");
	return root;
}

describe("resolveSandboxLimits", () => {
	test("profile memoryLimitMb wins over env and default", () => {
		const limits = resolveSandboxLimits({ memoryLimitMb: 1024 }, { [MEMORY_LIMIT_ENV]: "8192" });
		expect(limits).toEqual({ memoryLimitMb: 1024 });
	});

	test("unset profile falls back to the built-in default cap (burrow-2083)", () => {
		const limits = resolveSandboxLimits({}, {});
		expect(limits).toEqual({ memoryLimitMb: DEFAULT_SANDBOX_MEMORY_LIMIT_MB });
	});

	test("env overrides the default when the profile is silent", () => {
		const limits = resolveSandboxLimits({}, { [MEMORY_LIMIT_ENV]: "2048" });
		expect(limits).toEqual({ memoryLimitMb: 2048 });
	});

	test("env `0` opts out of the default cap entirely", () => {
		expect(resolveSandboxLimits({}, { [MEMORY_LIMIT_ENV]: "0" })).toBeNull();
	});

	test("env `0` with a cpuLimit still enforces cpu", () => {
		const limits = resolveSandboxLimits({ cpuLimit: 2 }, { [MEMORY_LIMIT_ENV]: "0" });
		expect(limits).toEqual({ cpuLimit: 2 });
	});

	test("garbage env falls back to the default cap, not unlimited", () => {
		const limits = resolveSandboxLimits({}, { [MEMORY_LIMIT_ENV]: "lots" });
		expect(limits).toEqual({ memoryLimitMb: DEFAULT_SANDBOX_MEMORY_LIMIT_MB });
	});

	test("cpuLimit passes through alongside memory", () => {
		const limits = resolveSandboxLimits({ memoryLimitMb: 512, cpuLimit: 1.5 }, {});
		expect(limits).toEqual({ memoryLimitMb: 512, cpuLimit: 1.5 });
	});
});

describe("prepareSandboxCgroup", () => {
	let root: string;

	beforeEach(() => {
		root = fakeCgroupRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("creates a leaf and writes memory.max in bytes", () => {
		const cg = prepareSandboxCgroup({ memoryLimitMb: 2048 }, { root, id: "test1" });
		expect(cg).not.toBeNull();
		if (!cg) return;
		expect(cg.dir).toBe(join(root, "warren-sb-test1"));
		expect(cg.procsPath).toBe(join(cg.dir, "cgroup.procs"));
		expect(readFileSync(join(cg.dir, "memory.max"), "utf8")).toBe(String(2048 * 1024 * 1024));
	});

	test("writes cpu.max as `quota period` when cpuLimit is set", () => {
		const cg = prepareSandboxCgroup({ memoryLimitMb: 512, cpuLimit: 2 }, { root, id: "cpu" });
		expect(cg).not.toBeNull();
		if (!cg) return;
		expect(readFileSync(join(cg.dir, "cpu.max"), "utf8")).toBe("200000 100000");
	});

	test("returns null when the cgroup v2 root is missing (macOS / no cgroupfs)", () => {
		const cg = prepareSandboxCgroup(
			{ memoryLimitMb: 1024 },
			{ root: join(root, "does-not-exist") },
		);
		expect(cg).toBeNull();
	});

	test("returns null when the memory controller is unavailable", () => {
		const noMem = fakeCgroupRoot("cpuset cpu io pids");
		try {
			expect(prepareSandboxCgroup({ memoryLimitMb: 1024 }, { root: noMem })).toBeNull();
		} finally {
			rmSync(noMem, { recursive: true, force: true });
		}
	});

	test("oomKilled reflects the leaf's memory.events oom_kill counter", () => {
		const cg = prepareSandboxCgroup({ memoryLimitMb: 1024 }, { root, id: "oom" });
		expect(cg).not.toBeNull();
		if (!cg) return;
		expect(cg.oomKilled()).toBe(false);
		writeFileSync(join(cg.dir, "memory.events"), "low 0\nhigh 3\nmax 12\noom 2\noom_kill 1\n");
		expect(cg.oomKilled()).toBe(true);
	});

	// Leaf removal itself can't be simulated on a plain filesystem: cleanup
	// uses a deliberately non-recursive rmdir (recursive deletion against
	// the real /sys/fs/cgroup would be wrong), and the fake root's
	// memory.max/memory.events are real files rather than kernel-virtual
	// ones, so rmdir always reports non-empty here. The removal path is
	// exercised implicitly on real cgroupfs; these tests pin the snapshot
	// + idempotency contract.
	test("cleanup snapshots the oom flag and is idempotent; a non-removable leaf is left in place", () => {
		const cg = prepareSandboxCgroup({ memoryLimitMb: 1024 }, { root, id: "clean" });
		expect(cg).not.toBeNull();
		if (!cg) return;
		writeFileSync(join(cg.dir, "memory.events"), "oom 1\noom_kill 1\n");
		cg.cleanup();
		cg.cleanup();
		expect(existsSync(cg.dir)).toBe(true);
		// truthful after teardown even once memory.events is gone —
		// dispatch consults it post-exit
		rmSync(join(cg.dir, "memory.events"));
		expect(cg.oomKilled()).toBe(true);
	});
});

describe("wrapArgvForCgroup", () => {
	test("shim enters the cgroup then execs the original argv verbatim", () => {
		const wrapped = wrapArgvForCgroup(["bwrap", "--unshare-all", "--", "echo", "hi"], "/p");
		expect(wrapped[0]).toBe("/bin/sh");
		expect(wrapped[1]).toBe("-c");
		expect(wrapped[2]).toBe('echo $$ > /p && exec "$@"');
		expect(wrapped[3]).toBe("warren-cgexec");
		expect(wrapped.slice(4)).toEqual(["bwrap", "--unshare-all", "--", "echo", "hi"]);
	});
});

describe("readOomKillCount", () => {
	test("parses oom_kill and ignores the sibling oom line", () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-oom-"));
		try {
			writeFileSync(join(dir, "memory.events"), "low 0\nhigh 0\nmax 4\noom 3\noom_kill 2\n");
			expect(readOomKillCount(dir)).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns 0 when memory.events is unreadable", () => {
		expect(readOomKillCount("/nope/never")).toBe(0);
	});
});
