/**
 * First-run onboarding helpers (warren-a911 / pl-26f3 step 9,
 * extended by warren-ed11 / step 11).
 *
 * Kept pure so the gate the landing route walks and the checklist's
 * live item states are testable without a DOM (same pattern as
 * `operations.helpers.ts`). Every input here derives from real API
 * rows or localStorage — the page never fabricates a state.
 */

import type { DispatchRouteState } from "./dispatch/dispatch-draft.ts";

/**
 * The agent the starter task prefills (warren-ed11 / pl-26f3 step 11).
 * Fresh installs ship `claude-code` in the builtin registry; if an
 * operator removed it, the dispatch form simply shows the prefill as
 * an empty match they correct before submitting.
 */
export const STARTER_TASK_AGENT = "claude-code";

/**
 * The prefilled starter-task prompt (warren-ed11). One exported
 * constant so the UI card, the tests, and any docs quote the same
 * string. Deliberately low-risk: read-only exploration plus one
 * documentation file, no assumption about the repo's language or
 * toolchain, and no main-branch writes — runs push their own branch
 * and open a PR by design.
 */
export const STARTER_TASK_PROMPT =
	"Explore this repository and write what you learn into an AGENTS.md at the repo root: what the project is, how the source is laid out, and the commands a coding agent should use to build and test it. Read the README and enough of the tree to be accurate — do not assume a particular language or toolchain, report what is actually there. Then open a pull request containing only that one documentation file. Keep the file under 60 lines and change nothing else.";

/**
 * Build the `/dispatch` route state for the starter offer: the
 * registered project, the `claude-code` agent, and the starter
 * prompt. The user reviews and presses the existing dispatch button —
 * there is no auto-dispatch.
 */
export function starterDispatchState(projectId: string): DispatchRouteState {
	return {
		project: projectId,
		agent: STARTER_TASK_AGENT,
		prompt: STARTER_TASK_PROMPT,
	};
}

/**
 * localStorage key holding the operator's manual dismissal of the
 * first-run checklist. The checklist retires on its own once a run
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
	/** Live run total from `GET /runs?limit=1`; null while in flight. */
	readonly runCount: RunCount;
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
 * The landing gate: a no-run instance shows the setup checklist to an
 * operator who has not dismissed it — zero projects, or one registered
 * but never dispatched from (warren-ed11 keeps the checklist up until
 * the first run exists, so the starter offer is reachable right after
 * a project registers). Ordering matters:
 *
 *   1. loading — any unknown input stays on the fence;
 *   2. spectator — the console, never onboarding actions
 *      (WARREN_AUTH=public read-only viewers);
 *   3. dismissed — the console, the operator opted out;
 *   4. a run exists — the console, the happy path is complete;
 *   5. otherwise — the checklist.
 */
export function setupLandingDecision(input: SetupLandingInput): SetupDecision {
	if (input.projects === undefined || input.runCount === null || input.canOperate === null) {
		return "loading";
	}
	if (!input.canOperate) return "console";
	if (input.dismissed) return "console";
	if (input.runCount > 0) return "console";
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
	/** Router state carried by an SPA-route step (the dispatch prefill). */
	readonly routeState?: DispatchRouteState;
}

export interface SetupStepInput {
	readonly projectCount: ProjectCount;
	readonly runCount: RunCount;
	/** Id of the first registered project; null while /projects is in flight. */
	readonly firstProjectId: string | null;
	/** Id of the most recent run; null while /runs is in flight. */
	readonly firstRunId: string | null;
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
			blurb: "Start from the ready-made task. The agent works on its own branch and opens a PR.",
			state: dispatchStepState(input.projectCount, input.runCount),
			href: dispatchStepHref(input),
			external: false,
			// The starter prefill rides along as router state — the
			// dispatch form renders it for review, never auto-submits.
			routeState:
				input.projectCount !== null && input.projectCount > 0 && input.firstProjectId !== null
					? starterDispatchState(input.firstProjectId)
					: undefined,
		},
	];
}

function dispatchStepHref(input: SetupStepInput): string {
	// Once the first run exists the step becomes "watch your run" —
	// a link to the live run detail using existing run-list data.
	if (input.runCount !== null && input.runCount > 0 && input.firstRunId !== null) {
		return `/runs/${encodeURIComponent(input.firstRunId)}`;
	}
	return "/dispatch";
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
