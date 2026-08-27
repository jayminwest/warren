import { describe, expect, test } from "bun:test";
import {
	buildSetupSteps,
	readSetupDismissed,
	SETUP_DISMISSAL_KEY,
	type SetupStep,
	setupLandingDecision,
	writeSetupDismissed,
} from "./setup.helpers.ts";

/**
 * First-run onboarding decision logic (warren-a911): the zero-project
 * gate, dismissal persistence, and the checklist's live item states.
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
	test("zero projects, operator, not dismissed renders the checklist", () => {
		expect(setupLandingDecision({ projects: [], canOperate: true, dismissed: false })).toBe(
			"setup",
		);
	});

	test("loading inputs stay on the fence instead of guessing", () => {
		expect(setupLandingDecision({ projects: undefined, canOperate: true, dismissed: false })).toBe(
			"loading",
		);
		expect(setupLandingDecision({ projects: [], canOperate: null, dismissed: false })).toBe(
			"loading",
		);
	});

	test("a project existing retires the checklist regardless of dismissal", () => {
		expect(
			setupLandingDecision({ projects: [{ id: "p1" }], canOperate: true, dismissed: false }),
		).toBe("console");
		expect(
			setupLandingDecision({ projects: [{ id: "p1" }], canOperate: true, dismissed: true }),
		).toBe("console");
	});

	test("a spectator never sees operator onboarding actions", () => {
		expect(setupLandingDecision({ projects: [], canOperate: false, dismissed: false })).toBe(
			"console",
		);
	});

	test("a dismissed operator lands on the console", () => {
		expect(setupLandingDecision({ projects: [], canOperate: true, dismissed: true })).toBe(
			"console",
		);
	});
});

describe("buildSetupSteps", () => {
	test("a fresh instance shows connect available, dispatch blocked, connect unknown", () => {
		const steps = buildSetupSteps({ projectCount: 0, runCount: 0 });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		// No forge-status JSON endpoint exists yet, so Connect GitHub is
		// deliberately stateless ("unknown"), never a guessed "done".
		expect(states.get("connect-github")).toBe("unknown");
		expect(states.get("add-repository")).toBe("available");
		expect(states.get("dispatch-run")).toBe("blocked");
	});

	test("in-flight counts render unknown rather than fabricated state", () => {
		const steps = buildSetupSteps({ projectCount: null, runCount: null });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		expect(states.get("add-repository")).toBe("unknown");
		expect(states.get("dispatch-run")).toBe("unknown");
	});

	test("adding a repository checks off step two and lights up dispatch", () => {
		const steps = buildSetupSteps({ projectCount: 1, runCount: 0 });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		expect(states.get("add-repository")).toBe("done");
		expect(states.get("dispatch-run")).toBe("available");
	});

	test("a dispatched run checks off step three", () => {
		const steps = buildSetupSteps({ projectCount: 1, runCount: 1 });
		const states = new Map(steps.map((s: SetupStep) => [s.id, s.state]));
		expect(states.get("dispatch-run")).toBe("done");
	});

	test("the Connect GitHub step links to the anonymous registration page", () => {
		const connect = buildSetupSteps({ projectCount: 0, runCount: 0 }).find(
			(s: SetupStep) => s.id === "connect-github",
		);
		expect(connect?.href).toBe("/github-app/register");
		expect(connect?.external).toBe(true);
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
