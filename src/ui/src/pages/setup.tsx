import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Lock } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { projectsApi, runsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { StatusBadge, type Tone } from "@/components/ui/status.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";
import {
	buildSetupSteps,
	readSetupDismissed,
	type SetupStep,
	type SetupStepState,
	setupLandingDecision,
	writeSetupDismissed,
} from "./setup.helpers.ts";

/**
 * First-run onboarding (warren-a911 / pl-26f3 step 9; restyled in
 * warren-9474).
 *
 * When an authenticated operator lands on an instance with zero
 * projects, the index route renders this setup checklist instead of
 * the empty operator console: connect GitHub, add a repository,
 * dispatch a first run. Once a project exists the checklist retires
 * on its own and the console renders exactly as before; a manual
 * `/setup` entry point stays reachable from the sidebar while no
 * project exists.
 *
 * Copy is casual-grade by design: no bwrap / k8s / PAT vocabulary on
 * this screen — the operator console is one click away for that.
 */

const STATE_LABEL: Record<SetupStepState, string> = {
	done: "Done",
	available: "Ready",
	blocked: "Add a repository first",
	unknown: "Not checked",
};

const STATE_TONE: Record<SetupStepState, Tone> = {
	done: "ok",
	available: "live",
	blocked: "idle",
	unknown: "idle",
};

/** The step's leading marker: a check when done, a lock when blocked, else its number. */
function StepMarker({ state, index }: { state: SetupStepState; index: number }) {
	if (state === "done") {
		return (
			<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--color-success)/15 text-(--color-success)">
				<Check aria-hidden className="size-4" />
			</span>
		);
	}
	return (
		<span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-(--color-border-strong) text-sm text-(--color-text-2) tabular-nums">
			{state === "blocked" ? <Lock aria-hidden className="size-3.5" /> : index + 1}
		</span>
	);
}

/** One checklist row: marker, title + blurb, state, and a chevron when it leads somewhere. */
function SetupStepRow({ step, index }: { step: SetupStep; index: number }) {
	const passive = !step.external && (step.state === "blocked" || step.state === "unknown");
	const body = (
		<>
			<StepMarker state={step.state} index={index} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<span
						className={cn(
							"text-sm font-medium",
							step.state === "done" ? "text-(--color-text-2)" : "text-(--color-text)",
						)}
					>
						{step.title}
					</span>
					<StatusBadge
						state={step.state}
						tone={STATE_TONE[step.state]}
						label={STATE_LABEL[step.state]}
					/>
				</div>
				<p className="text-sm text-(--color-text-3)">{step.blurb}</p>
			</div>
			{passive ? null : (
				<ChevronRight aria-hidden className="mt-1.5 size-4 shrink-0 text-(--color-text-3)" />
			)}
		</>
	);

	const rowClass = cn(
		"flex items-start gap-3.5 px-4 py-4 transition-colors",
		passive ? "opacity-60" : "hover:bg-(--color-surface-hover)",
	);

	// Connect GitHub leaves the SPA: /github-app/register is a
	// server-rendered anonymous page (warren-a647), so it needs a plain
	// navigation, not a HashRouter <Link>. The other steps stay inside
	// the SPA. Blocked and unknown steps render as passive rows.
	if (step.external) {
		return (
			<a href={step.href} className={rowClass}>
				{body}
			</a>
		);
	}
	if (passive) return <div className={rowClass}>{body}</div>;
	return (
		// The starter prefill rides in as router state (warren-ed11):
		// the dispatch form renders it for review — nothing auto-submits.
		<Link to={step.href} state={step.routeState} className={rowClass}>
			{body}
		</Link>
	);
}

/** Thin progress bar: one segment per step, filled when done. */
function Progress({ steps }: { steps: readonly SetupStep[] }) {
	const done = steps.filter((s) => s.state === "done").length;
	return (
		<div className="flex items-center gap-3">
			<div className="flex flex-1 gap-1" aria-hidden>
				{steps.map((s) => (
					<span
						key={s.id}
						className={cn(
							"h-1 flex-1 rounded-full",
							s.state === "done" ? "bg-(--color-success)" : "bg-(--color-surface-hover)",
						)}
					/>
				))}
			</div>
			<span className="text-xs text-(--color-text-3) tabular-nums">
				{done} of {steps.length} done
			</span>
		</div>
	);
}

/** Live inputs the checklist renders from; null while in flight. */
function useSetupFacts() {
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const runs = useQuery({
		// Own key, not the bare ["runs"] the Runs page uses: a limit-1
		// probe must not clobber a full list cache entry.
		queryKey: ["setup", "runs-count"],
		queryFn: ({ signal }) => runsApi.list({ limit: 1 }, signal),
		staleTime: 15_000,
	});
	const projectRows = projects.data?.projects ?? [];
	const runRows = runs.data?.runs ?? [];
	return {
		projectCount: projects.data ? projectRows.length : null,
		runCount: runs.data ? runs.data.total : null,
		loading: projects.isLoading || runs.isLoading,
		firstProjectId: projectRows.length > 0 ? (projectRows[0]?.id ?? null) : null,
		firstRunId: runRows.length > 0 ? (runRows[0]?.id ?? null) : null,
	};
}

/** The setup checklist page, mounted at `/` (zero-project landing) and `/setup`. */
export function SetupPage() {
	const navigate = useNavigate();
	const caps = useCapabilities();
	const { projectCount, runCount, firstProjectId, firstRunId, loading } = useSetupFacts();

	const handleDismiss = (): void => {
		writeSetupDismissed();
		navigate("/operations", { replace: true });
	};

	const steps = buildSetupSteps({ projectCount, runCount, firstProjectId, firstRunId });

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-3.5 pt-8 pb-12 md:px-6">
			<PageHeader
				title="Welcome to warren"
				description="Three steps to your first finished run. Your progress saves as you go, so come back any time."
			/>
			<Progress steps={steps} />
			<Card className="w-full">
				{loading ? (
					<SkeletonRows rows={3} />
				) : (
					<div className="divide-y divide-(--color-border)">
						{steps.map((step, i) => (
							<SetupStepRow key={step.id} step={step} index={i} />
						))}
					</div>
				)}
			</Card>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button variant="ghost" onClick={handleDismiss} disabled={caps.status === "loading"}>
					Skip setup for now
				</Button>
				<Button variant="outline" onClick={() => navigate("/operations")}>
					Go to the console
				</Button>
			</div>
		</div>
	);
}

/**
 * The index route's gate (warren-a911): a zero-project instance lands
 * an undismissed operator on the checklist; everyone else — including
 * every spectator under `WARREN_AUTH=public` — gets the operator
 * console: the `children` landing (Home, warren-44a2).
 */
export function SetupLandingRoute({ children }: { children: ReactElement }) {
	const caps = useCapabilities();
	const [dismissed] = useState(() => readSetupDismissed());
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	// Same limit-1 probe (and key) the checklist page uses: warren-ed11
	// keeps the checklist the landing until the first run dispatches,
	// so the gate needs the run total, not just the project rows.
	const runs = useQuery({
		queryKey: ["setup", "runs-count"],
		queryFn: ({ signal }) => runsApi.list({ limit: 1 }, signal),
		staleTime: 15_000,
	});

	const decision = setupLandingDecision({
		projects: projects.data?.projects,
		runCount: runs.data ? runs.data.total : null,
		canOperate: caps.status === "ready" ? caps.can("admin") : null,
		dismissed,
	});

	// Either destination may follow, so draw nothing rather than guess (the
	// answer is usually one round trip away).
	if (decision === "loading") return null;
	if (decision === "console") return children;
	return <SetupPage />;
}
