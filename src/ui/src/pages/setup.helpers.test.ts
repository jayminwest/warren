import { describe, expect, test } from "bun:test";
import { initialDraft, initialTouched } from "./dispatch/dispatch-draft.ts";
import {
	buildSetupSteps,
	readSetupDismissed,
	SETUP_DISMISSAL_KEY,
	type SetupStep,
	STARTER_TASK_AGENT,
	STARTER_TASK_PROMPT,
	setupLandingDecision,
	starterDispatchState,
	writeSetupDismissed,
} from "./setup.helpers.ts";

/**
 * First-run onboarding decision logic (warren-a911, extended by
 * warren-ed11): the no-run gate, dismissal persistence, the
 * checklist's live item states, and the starter-task prefill.
 */

function localStorageStub(): { values: Map<string, string> } {
	const values = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => values.get(k) ?? null,
		setItem: (k: string, v: string) => {
			values.set(k, v);
		},
		removeItem: (k: string) => {
			values.delete(k);
		},
	};
	return { values };
}

describe("setupLandingDecision", () => {
	test("zero projects, zero runs, operator, not dismissed renders the checklist", () => {
		expect(
			setupLandingDecision({ projects: [], runCount: 0, canOperate: true, dismissed: false }),
		).toBe("setup");
	});

	test("loading inputs stay on the fence instead of guessing", () => {
		expect(
			setupLandingDecision({
				projects: undefined,
				runCount: 0,
				canOperate: true,
				dismissed: false,
			}),
		).toBe("loading");
		expect(
			setupLandingDecision({ projects: [], runCount: null, canOperate: true, dismissed: false }),
		).toBe("loading");
		expect(
			setupLandingDecision({ projects: [], runCount: 0, canOperate: null, dismissed: false }),
		).toBe("loading");
	});

	test("a registered project with no runs keeps the checklist up (warren-ed11)", () => {
		expect(
			setupLandingDecision({
				projects: [{ id: "p1" }],
				runCount: 0,
				canOperate: true,
				dismissed: false,
			}),
		).toBe("setup");
	});

	test("a dispatched run retires the checklist regardless of project count", () => {
		expect(
			setupLandingDecision({ projects: [], runCount: 1, canOperate: true, dismissed: false }),
		).toBe("console");
		expect(
			setupLandingDecision({
				projects: [{ id: "p1" }],
				runCount: 1,
				canOperate: true,
				dismissed: false,
			}),
		).toBe("console");
	});

	test("a spectator never sees operator onboarding actions", () => {
		expect(
			setupLandingDecision({ projects: [], runCount: 0, canOperate: false, dismissed: false }),
		).toBe("console");
	});

	test("a dismissed operator lands on the console", () => {
		expect(
			setupLandingDecision({ projects: [], runCount: 0, canOperate: true, dismissed: true }),
		).toBe("console");
	});
});

describe("buildSetupSteps", () => {
	function stepsFor(over: Partial<Parameters<typeof buildSetupSteps>[0]> = {}) {
		const input = {
			projectCount: 0,
			runCount: 0,
			firstProjectId: null,
			firstRunId: null,
			...over,
		};
		return buildSetupSteps(input);
	}

	test("a fresh instance shows connect available, dispatch blocked, connect unknown", () => {
		const steps = stepsFor();
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		// No forge-status JSON endpoint exists yet, so Connect GitHub is
		// deliberately stateless ("unknown"), never a guessed "done".
		expect(states.get("connect-github")).toBe("unknown");
		expect(states.get("add-repository")).toBe("available");
		expect(states.get("dispatch-run")).toBe("blocked");
	});

	test("in-flight counts render unknown rather than fabricated state", () => {
		const steps = stepsFor({ projectCount: null, runCount: null });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		expect(states.get("add-repository")).toBe("unknown");
		expect(states.get("dispatch-run")).toBe("unknown");
	});

	test("adding a repository checks off step two and lights up dispatch", () => {
		const steps = stepsFor({ projectCount: 1, firstProjectId: "p1" });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		expect(states.get("add-repository")).toBe("done");
		expect(states.get("dispatch-run")).toBe("available");
	});

	test("a dispatched run checks off step three and links to the live run", () => {
		const steps = stepsFor({
			projectCount: 1,
			runCount: 1,
			firstProjectId: "p1",
			firstRunId: "r9",
		});
		const dispatch = steps.find((s: SetupStep) => s.id === "dispatch-run");
		expect(dispatch?.state).toBe("done");
		expect(dispatch?.href).toBe("/runs/r9");
	});

	test("the Connect GitHub step links to the anonymous registration page", () => {
		const connect = stepsFor().find((s: SetupStep) => s.id === "connect-github");
		expect(connect?.href).toBe("/github-app/register");
		expect(connect?.external).toBe(true);
	});
});

describe("starter task prefill (warren-ed11)", () => {
	test("the dispatch step carries the starter route state once a project exists", () => {
		const dispatch = buildSetupSteps({
			projectCount: 1,
			runCount: 0,
			firstProjectId: "p1",
			firstRunId: null,
		}).find((s: SetupStep) => s.id === "dispatch-run");
		expect(dispatch?.routeState).toEqual(starterDispatchState("p1"));
	});

	test("no project means no starter prefill — dispatch stays a plain link", () => {
		const dispatch = buildSetupSteps({
			projectCount: 0,
			runCount: 0,
			firstProjectId: null,
			firstRunId: null,
		}).find((s: SetupStep) => s.id === "dispatch-run");
		expect(dispatch?.routeState).toBeUndefined();
	});

	test("the starter prefill lands intact in the dispatch form draft", () => {
		const routeState = starterDispatchState("p1");
		const draft = initialDraft(routeState);
		expect(draft.project).toBe("p1");
		expect(draft.agent).toBe(STARTER_TASK_AGENT);
		expect(draft.prompt).toBe(STARTER_TASK_PROMPT);
		// Touched flags keep the per-project defaults from clobbering
		// the prefilled agent and prompt.
		const touched = initialTouched(routeState);
		expect(touched.agent).toBe(true);
		expect(touched.prompt).toBe(true);
	});

	test("the starter prompt is a bounded, read-only documentation task", () => {
		const p = STARTER_TASK_PROMPT;
		expect(p.length).toBeGreaterThan(100);
		expect(p.length).toBeLessThan(600);
		expect(p).toContain("AGENTS.md");
		expect(p).toContain("pull request");
	});
});

describe("setup dismissal persistence", () => {
	test("an unwritten key reads false", () => {
		const { values } = localStorageStub();
		expect(readSetupDismissed()).toBe(false);
		expect(values.size).toBe(0);
	});

	test("writing then reading round-trips through localStorage", () => {
		const { values } = localStorageStub();
		writeSetupDismissed();
		expect(values.get(SETUP_DISMISSAL_KEY)).toBe("1");
		expect(readSetupDismissed()).toBe(true);
	});
});
