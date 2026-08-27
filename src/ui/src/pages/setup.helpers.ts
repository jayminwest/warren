/**
 * First-run onboarding helpers (warren-a911 / pl-26f3 step 9).
 *
 * Kept pure so the gate the landing route walks and the checklist's
 * live item states are testable without a DOM (same pattern as
 * `operations.helpers.ts`). Every input here derives from real API
 * rows or localStorage — the page never fabricates a state.
 */

/**
 * localStorage key holding the operator's manual dismissal of the
 * first-run checklist. The checklist retires on its own once a project
 * exists; this key only covers "dismissed before finishing setup".
 */
export const SETUP_DISMISSAL_KEY = "warren.setupDismissed";

/** `null` while /projects is in flight or errored. */
type ProjectCount = number | null;

/** `null` while /runs is in flight or errored. */
type RunCount = number | null;

/** What the index route should render right now. */
export type SetupDecision = "loading" | "setup" | "console";

export interface SetupLandingInput {
	/** Live project rows from `GET /projects`; undefined while in flight. */
	readonly projects: readonly unknown[] | undefined;
	/**
	 * Can this browser mutate the instance (operator)? `null` while
	 * /whoami is in flight — the decision must not fire on an unknown
	 * answer, or a slow first paint would bounce the operator off the
	 * checklist they deep-linked to.
	 */
	readonly canOperate: boolean | null;
	/** Has the operator dismissed the checklist in this browser? */
	readonly dismissed: boolean;
}

/**
 * The landing gate: a zero-project instance shows the setup checklist
 * to an operator who has not dismissed it; every other caller sees the
 * operator console exactly as before. Ordering matters:
 *
 *   1. loading — any unknown input stays on the fence;
 *   2. projects exist — the console, always, regardless of dismissal
 *      state (the checklist never renders again once a project exists);
 *   3. spectator — the console, never onboarding actions
 *      (WARREN_AUTH=public read-only viewers);
 *   4. dismissed — the console, the operator opted out;
 *   5. otherwise — the checklist.
 */
export function setupLandingDecision(input: SetupLandingInput): SetupDecision {
	if (input.projects === undefined || input.canOperate === null) return "loading";
	if (input.projects.length > 0) return "console";
	if (!input.canOperate) return "console";
	if (input.dismissed) return "console";
	return "setup";
}

/** Live state of one checklist item. */
export type SetupStepState = "done" | "available" | "blocked" | "unknown";

export interface SetupStep {
	readonly id: "connect-github" | "add-repository" | "dispatch-run";
	readonly title: string;
	/** One plain sentence of what and why — casual-grade, no jargon. */
	readonly blurb: string;
	readonly state: SetupStepState;
	/** Destination. Hash route for SPA pages; full path for server pages. */
	readonly href: string;
	/** True when the destination is a server-rendered page, not an SPA route. */
	readonly external: boolean;
}

export interface SetupStepInput {
	readonly projectCount: ProjectCount;
	readonly runCount: RunCount;
}

/**
 * Build the three checklist items with live state. `projectCount` and
 * `runCount` are null while their queries are in flight — items then
 * render as `unknown` rather than guessing, matching the shell's
 * never-fabricate rule (`use-console-stats.ts`).
 */
export function buildSetupSteps(input: SetupStepInput): readonly SetupStep[] {
	return [
		{
			id: "connect-github",
			title: "Connect GitHub",
			blurb:
				"Link your GitHub account so warren can read your repositories and deliver finished work back as pull requests.",
			// warren-b504 activates the forge at the end of the App flow, but
			// no JSON endpoint reports the active forge kind yet (the dispatch
			// manifest renders the same gap as an unknown row). Until one
			// lands, this item renders stateless with a verify hint instead
			// of guessing — deliberately NOT a new server route in this step.
			state: "unknown",
			href: "/github-app/register",
			external: true,
		},
		{
			id: "add-repository",
			title: "Add a repository",
			blurb: "Tell warren which repository to work on — it keeps its own copy and works from that.",
			state: addRepoStepState(input.projectCount),
			href: "/projects",
			external: false,
		},
		{
			id: "dispatch-run",
			title: "Dispatch your first run",
			blurb:
				"Describe a small task and let an agent do it — you will see the work land as a pull request.",
			state: dispatchStepState(input.projectCount, input.runCount),
			href: "/dispatch",
			external: false,
		},
	];
}

function addRepoStepState(projectCount: ProjectCount): SetupStepState {
	if (projectCount === null) return "unknown";
	return projectCount > 0 ? "done" : "available";
}

function dispatchStepState(projectCount: ProjectCount, runCount: RunCount): SetupStepState {
	if (runCount !== null && runCount > 0) return "done";
	if (projectCount === null) return "unknown";
	// The dispatch page needs a project to point a run at, so the item
	// stays quiet ("lights up") until step 2 is complete.
	return projectCount > 0 ? "available" : "blocked";
}

/** Read the dismissal flag; false when localStorage is unavailable. */
export function readSetupDismissed(): boolean {
	try {
		return localStorage.getItem(SETUP_DISMISSAL_KEY) === "1";
	} catch {
		return false;
	}
}

/** Persist the dismissal for this browser. */
export function writeSetupDismissed(): void {
	try {
		localStorage.setItem(SETUP_DISMISSAL_KEY, "1");
	} catch {
		// Private mode — the dismissal lives for the session only.
	}
}
