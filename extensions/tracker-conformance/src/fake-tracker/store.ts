/**
 * FakeTracker in-memory store (warren-53ea) — the state half of the
 * reference warren-tracker/v1 server. Deliberately dumb: issues and
 * plans live in Maps seeded from a fixture; the only write semantics
 * are the ones the protocol pins down (idempotent close, shallow-merge
 * metadata with null-clears). An optional state file mirrors every
 * mutation to disk so a separate process (warren's acceptance harness)
 * can assert what the tracker observed — the same cross-process
 * observation seam FakeForge uses (WARREN_FAKE_FORGE_STATE_FILE).
 */

import { writeFile } from "node:fs/promises";

export interface FakeIssue {
	id: string;
	status: string;
	title?: string;
	description?: string;
	blockedBy?: string[];
	metadata?: Record<string, unknown>;
	scheduledFor?: string;
}

export interface FakePlanStep {
	title?: string;
	existingSeed?: string;
	blocks?: number[];
}

export interface FakePlan {
	id: string;
	status: string;
	children: string[];
	steps?: FakePlanStep[];
	name?: string;
	childCount?: number;
}

/** Fixture shape: the initial state a FakeTracker boots with. */
export interface FakeTrackerFixture {
	readonly issues?: readonly FakeIssue[];
	readonly plans?: readonly FakePlan[];
}

/** A recorded call, for cross-process request assertions. */
export interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly at: string;
}

/** The on-disk mirror shape (state-file seam). */
export interface FakeTrackerStateFile {
	readonly issues: readonly FakeIssue[];
	readonly plans: readonly FakePlan[];
	readonly calls: readonly RecordedCall[];
}

const MAX_RECORDED_CALLS = 1000;

export class FakeTrackerStore {
	private readonly issues = new Map<string, FakeIssue>();
	private readonly plans = new Map<string, FakePlan>();
	private readonly calls: RecordedCall[] = [];

	constructor(
		fixture: FakeTrackerFixture = {},
		private readonly stateFilePath?: string,
		private readonly now: () => Date = () => new Date(),
	) {
		for (const issue of fixture.issues ?? []) {
			this.issues.set(issue.id, structuredClone(issue));
		}
		for (const plan of fixture.plans ?? []) {
			this.plans.set(plan.id, structuredClone(plan));
		}
	}

	recordCall(method: string, path: string): void {
		this.calls.push({ method, path, at: this.now().toISOString() });
		if (this.calls.length > MAX_RECORDED_CALLS) {
			this.calls.splice(0, this.calls.length - MAX_RECORDED_CALLS);
		}
	}

	getIssue(id: string): FakeIssue | undefined {
		const issue = this.issues.get(id);
		return issue === undefined ? undefined : structuredClone(issue);
	}

	/** Idempotent: closing an unknown id misses, closing a closed one is a noop. */
	closeIssue(id: string): "closed" | "not_found" {
		const issue = this.issues.get(id);
		if (issue === undefined) return "not_found";
		issue.status = "closed";
		return "closed";
	}

	listStatuses(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [id, issue] of this.issues) {
			out[id] = issue.status;
		}
		return out;
	}

	listPlans(): FakePlan[] {
		return [...this.plans.values()].map((p) => structuredClone(p));
	}

	getPlan(id: string): FakePlan | undefined {
		const plan = this.plans.get(id);
		return plan === undefined ? undefined : structuredClone(plan);
	}

	/** Shallow merge; an explicit `null` value clears the key. */
	mergeMetadata(id: string, metadata: Readonly<Record<string, unknown>>): "merged" | "not_found" {
		const issue = this.issues.get(id);
		if (issue === undefined) return "not_found";
		const current: Record<string, unknown> = { ...(issue.metadata ?? {}) };
		for (const [key, value] of Object.entries(metadata)) {
			if (value === null) {
				delete current[key];
			} else {
				current[key] = value;
			}
		}
		issue.metadata = current;
		return "merged";
	}

	listScheduledIssues(): FakeIssue[] {
		return [...this.issues.values()]
			.filter((i) => typeof i.scheduledFor === "string" && i.status !== "closed")
			.map((i) => structuredClone(i));
	}

	/** Persist the state-file mirror (awaited by the server post-mutation). */
	async flush(): Promise<void> {
		if (this.stateFilePath === undefined) return;
		const snapshot: FakeTrackerStateFile = {
			issues: [...this.issues.values()].map((i) => structuredClone(i)),
			plans: [...this.plans.values()].map((p) => structuredClone(p)),
			calls: [...this.calls],
		};
		await writeFile(this.stateFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	}
}
