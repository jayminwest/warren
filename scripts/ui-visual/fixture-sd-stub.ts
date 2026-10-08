/**
 * The `sd` stub for the ui-visual fixture boot (warren-010b).
 *
 * Scenario 39's stub (`39-public-exposure.sd-stub.ts`) answers every read
 * with an empty envelope, which leaves `GET /projects/:id/seeds/:seedId`
 * a 500 (the show envelope needs an `issue`) and the plan pickers empty.
 * Screenshots need populated, error-free tracker reads, so this stub
 * serves a fixed issue + plan set for the fixture's seed ids, answering
 * exactly the four reads warren shells out for (`src/seeds-cli/`):
 * `list --format json`, `show <id> --json`, `plan list --json`, and
 * `plan show <id> --json`. Unknown seed ids still return a valid issue
 * (status `open`) so no read 500s. Writes (`close`, `update`) succeed as
 * no-ops; the fixture holds the scheduler and coordinator off anyway.
 */

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FIXTURE_NOW_MS } from "./fixture-data.ts";

interface StubIssue {
	readonly id: string;
	readonly title: string;
	readonly status: "open" | "in_progress" | "closed";
	readonly type: "task" | "bug" | "feature";
	readonly priority: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface StubPlan {
	readonly id: string;
	readonly seed: string;
	readonly name: string;
	readonly template: string;
	readonly status: "draft" | "approved" | "active" | "done";
	readonly revision: number;
	readonly children: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

const DAY_MS = 24 * 60 * 60_000;
const CREATED = new Date(FIXTURE_NOW_MS - 20 * DAY_MS).toISOString();
const UPDATED = new Date(FIXTURE_NOW_MS - 2 * DAY_MS).toISOString();

function issue(id: string, title: string, status: StubIssue["status"], priority = 2): StubIssue {
	return { id, title, status, type: "task", priority, createdAt: CREATED, updatedAt: UPDATED };
}

const PLAN_ONE_CHILDREN = [
	["ah-fx-21", "Runs table: replace the fixed gutter literal", "closed"],
	["ah-fx-22", "Plan-runs table: size cards to content", "closed"],
	["ah-fx-23", "Telemetry: one histogram column per day", "open"],
	["ah-fx-24", "Operations: services panel copy pass", "in_progress"],
	["ah-fx-25", "Project detail: phone header actions", "in_progress"],
	["ah-fx-26", "Dispatch: agent and model row on phones", "open"],
	["ah-fx-27", "Bottom nav: fix numbering", "closed"],
] as const;

const PLAN_TWO_CHILDREN = [
	["ah-fx-41", "Agents page: group library rows under a legacy heading", "open"],
	["ah-fx-42", "Agents page: show runtime and model tier chips", "open"],
	["ah-fx-43", "Agents page: empty state copy", "open"],
] as const;

/** The fixed issue set: plan children, plan parents, and every run's seed. */
function stubIssues(): StubIssue[] {
	const issues: StubIssue[] = [
		issue("ah-stub-1", "stub seed closed by acceptance harness", "open", 3),
		issue("ah-fx-20", "UI polish: phone layouts and table gutters", "in_progress", 1),
		issue("ah-fx-40", "Agents page cleanup", "open", 2),
		issue("ah-fx-102", "Runs table overflows at 393px", "in_progress", 1),
		issue("ah-fx-104", "Migrate the plan-runs table to the card primitive", "open", 2),
		issue("ah-fx-106", "Telemetry deep links break on phone widths", "in_progress", 2),
	];
	for (const [id, title, status] of [...PLAN_ONE_CHILDREN, ...PLAN_TWO_CHILDREN]) {
		issues.push(issue(id, title, status));
	}
	for (let i = 0; i < 18; i++) {
		issues.push(
			issue(`ah-fx-3${String(i).padStart(2, "0")}`, `Telemetry panel tidy ${i + 1}`, "closed", 3),
		);
	}
	return issues;
}

function stubPlans(): StubPlan[] {
	return [
		{
			id: "pl-fx01",
			seed: "ah-fx-20",
			name: "UI polish: phone layouts and table gutters",
			template: "feature",
			status: "active",
			revision: 2,
			children: PLAN_ONE_CHILDREN.map(([id]) => id),
			createdAt: CREATED,
			updatedAt: UPDATED,
		},
		{
			id: "pl-fx02",
			seed: "ah-fx-40",
			name: "Agents page cleanup",
			template: "refactor",
			status: "approved",
			revision: 1,
			children: PLAN_TWO_CHILDREN.map(([id]) => id),
			createdAt: CREATED,
			updatedAt: UPDATED,
		},
	];
}

/**
 * The stub's program text. The data is inlined as JSON so the executable
 * is self-contained (warren spawns it with the project clone as cwd).
 */
function stubProgram(): string {
	const data = JSON.stringify({ issues: stubIssues(), plans: stubPlans() });
	return `#!/usr/bin/env bun
const DATA = ${data};
const a = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify({ success: true, ...v }));
const findIssue = (id) =>
	DATA.issues.find((i) => i.id === id) ??
	{ id, title: id, status: "open", type: "task", priority: 2, createdAt: "${CREATED}", updatedAt: "${UPDATED}" };
if (a[0] === "plan" && a[1] === "list") out({ plans: DATA.plans });
else if (a[0] === "plan" && a[1] === "show") {
	const plan = DATA.plans.find((p) => p.id === a[2]);
	if (plan === undefined) { console.error("plan not found: " + a[2]); process.exit(1); }
	out({ plan: { ...plan, sections: { steps: plan.children.map((id) => ({ existing_seed: id })) } } });
} else if (a[0] === "show") out({ issue: findIssue(a[1]) });
else if (a[0] === "list") out({ issues: DATA.issues });
else out({});
`;
}

/** Write the stub into `dir` and return its path (the `WARREN_SD_BINARY` value). */
export async function writeFixtureSdStub(dir: string): Promise<string> {
	const path = join(dir, "sd-stub");
	await writeFile(path, stubProgram());
	await chmod(path, 0o755);
	return path;
}
