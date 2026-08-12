/**
 * Acceptance harness — cross-process driver for FakeForge state.
 *
 * Scenarios boot warren as a SUBPROCESS (lib/inproc.ts), so the
 * in-process seeding seams on `FakeForge` (`markMerged` & friends,
 * src/forge/fake/fake-forge.ts) are unreachable. When the booted warren
 * runs with `WARREN_FORGE=fake` + `WARREN_FAKE_FORGE_STATE_FILE=<path>`,
 * its store reloads this JSON document before every read and persists
 * after every mutation (src/forge/fake/store.ts, warren-2600) — so the
 * harness drives state transitions GitHub would drive externally by
 * editing the file.
 *
 * `startFakeForgeAutoMerge` plays the role GitHub's auto-merge workflow
 * plays in production (forge-contract.md §1: "warren merges through
 * GitHub's auto-merge workflow, not through the API"): every open PR the
 * fake records is flipped to `merged` on the next tick, so the plan-run
 * coordinator's merge gate advances exactly as it would against a real
 * repository with auto-merge enabled.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Minimal read view over the persisted `FakeForgeStateFile`. */
interface FakeStateView {
	prs?: Record<string, { lifecycle: string; mergedAt: number | null }[]>;
}

export interface FakeForgeAutoMergeHandle {
	stop(): void;
}

/** One auto-merge tick: flip every recorded open PR to merged. */
function mergeOpenPrsOnce(stateFile: string): void {
	if (!existsSync(stateFile)) return;
	let state: FakeStateView;
	try {
		state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeStateView;
	} catch {
		// Torn read (a persist mid-rename on some filesystems) — retry
		// next tick rather than killing the driver.
		return;
	}
	let changed = false;
	for (const list of Object.values(state.prs ?? {})) {
		for (const pr of list) {
			if (pr.lifecycle === "open") {
				pr.lifecycle = "merged";
				pr.mergedAt = Date.now();
				changed = true;
			}
		}
	}
	if (!changed) return;
	// Atomic tmp+rename so warren's reload never sees a partial write.
	const tmp = `${stateFile}.auto-merge-${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, stateFile);
}

export function startFakeForgeAutoMerge(
	stateFile: string,
	intervalMs = 200,
): FakeForgeAutoMergeHandle {
	const timer = setInterval(() => mergeOpenPrsOnce(stateFile), intervalMs);
	return {
		stop: () => clearInterval(timer),
	};
}
