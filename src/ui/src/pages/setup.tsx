import { useQuery } from "@tanstack/react-query";
import { Circle, CircleCheck, CircleHelp, Lock } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { projectsApi, runsApi } from "@/api/client.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
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
 * First-run onboarding (warren-a911 / pl-26f3 step 9).
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
	done: "done",
	available: "ready",
	blocked: "add a repository first",
	unknown: "not verified yet",
};

const STATE_ICON: Record<SetupStepState, typeof Circle> = {
	done: CircleCheck,
	available: Circle,
	blocked: Lock,
	unknown: CircleHelp,
};

/** One checklist row: state icon, title, blurb, destination link. */
function SetupStepRow({ step, index }: { step: SetupStep; index: number }) {
	const Icon = STATE_ICON[step.state];
	const body = (
		<>
			<span
				className={cn(
					"flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) border font-mono text-[11px]",
					step.state === "done"
						? "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
						: "border-(--color-border) text-(--color-text-3)",
				)}
			>
				{step.state === "done" ? <Icon className="h-4 w-4" /> : String(index + 1).padStart(2, "0")}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[13px] leading-4 font-medium text-(--color-text)">
						{step.title}
					</span>
					<Badge variant={step.state === "done" ? "done" : "secondary"}>
						{STATE_LABEL[step.state]}
					</Badge>
				</div>
				<p className="text-[12px] leading-[16px] text-(--color-text-2)">{step.blurb}</p>
			</div>
		</>
	);

	const rowClass = cn(
		"flex items-start gap-3 rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) p-3.5",
		step.state === "blocked" ? "opacity-70" : "",
	);

	// Connect GitHub leaves the SPA: /github-app/register is a
	// server-rendered anonymous page (warren-a647), so it needs a plain
	// navigation, not a HashRouter <Link>. The other steps stay inside
	// the SPA. Blocked and unknown steps render as passive rows.
	if (step.external) {
		return (
			<a href={step.href} className={cn(rowClass, "hover:bg-(--color-surface-raised)")}>
				{body}
			</a>
		);
	}
	if (step.state === "blocked" || step.state === "unknown") {
		return <div className={rowClass}>{body}</div>;
	}
	return (
		// The starter prefill rides in as router state (warren-ed11):
		// the dispatch form renders it for review — nothing auto-submits.
		<Link
			to={step.href}
			state={step.routeState}
			className={cn(rowClass, "hover:bg-(--color-surface-raised)")}
		>
			{body}
		</Link>
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
		projectsReady: projects.data !== undefined,
		firstProjectId: projectRows.length > 0 ? (projectRows[0]?.id ?? null) : null,
		firstRunId: runRows.length > 0 ? (runRows[0]?.id ?? null) : null,
	};
}

/** The setup checklist page, mounted at `/` (zero-project landing) and `/setup`. */
export function SetupPage() {
	const navigate = useNavigate();
	const caps = useCapabilities();
	const { projectCount, runCount, firstProjectId, firstRunId } = useSetupFacts();

	const handleDismiss = (): void => {
		writeSetupDismissed();
		navigate("/operations", { replace: true });
	};

	const steps = buildSetupSteps({ projectCount, runCount, firstProjectId, firstRunId });
	const doneCount = steps.filter((s) => s.state === "done").length;

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-6">
			<div className="flex flex-col gap-2">
				<h1 className="text-[18px] leading-6 font-semibold tracking-[-0.01em] text-(--color-text)">
					Welcome to warren
				</h1>
				<p className="text-[13px] leading-[18px] text-(--color-text-2)">
					Three quick steps to your first finished run. Your progress is saved — come back any time.
				</p>
			</div>
			<div className="flex flex-col gap-2.5">
				{steps.map((step, i) => (
					<SetupStepRow key={step.id} step={step} index={i} />
				))}
			</div>
			<p className="text-[11px] leading-[14px] text-(--color-text-3)">
				{doneCount > 0
					? `${doneCount} of ${steps.length} steps complete.`
					: "Nothing set up yet — start with Connect GitHub above."}
			</p>
			<div className="flex items-center justify-between">
				<Button
					variant="ghost"
					size="sm"
					onClick={handleDismiss}
					disabled={caps.status === "loading"}
				>
					Skip setup for now
				</Button>
				<Button variant="outline" size="sm" onClick={() => navigate("/operations")}>
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
 * console exactly as before.
 */
export function SetupLandingRoute() {
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

	if (decision === "loading") {
		return (
			<div className="flex items-center justify-center p-12">
				<Spinner />
			</div>
		);
	}
	if (decision === "console") return <Navigate to="/operations" replace />;
	return <SetupPage />;
}
