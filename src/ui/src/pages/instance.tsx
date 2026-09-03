import { useQuery } from "@tanstack/react-query";
import { metaApi } from "@/api/client.ts";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The Direction C Instance page (warren-e680 / pl-7e38 step 18) —
 * boot-resolved configuration, read-only, over `GET /instance`
 * (warren-2eec). Warren has no mutable settings state: everything here
 * resolves from env at boot or from a project's `.warren/config.yaml`,
 * so the page is a facts surface, never a form.
 *
 * The body varies with `Authorization`: under `WARREN_AUTH=public` the
 * spectator gets the reduced static projection, and the operator-only
 * fields (db backend, uptime, admission caps) render as quiet "—"
 * placeholders. No fabricated values — fields with no API yet stay
 * placeholders naming where they land.
 */

/** Runtime kind → the label the console's vocabulary uses. */
const RUNTIME_LABELS: Record<InstanceFactsResponse["runtime"], string> = {
	local: "local · bwrap",
	docker: "docker · sibling container",
	k8s: "kubernetes · pod",
};

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Labeled read-only value row; `hint` rides under the value in mono.
 *
 * Below md the value renders inside the mock's inset bordered box:
 * editable-shaped surfaces get `--color-bg` + border-strong, while
 * boot-resolved facts sit on `--color-surface-raised` + border.
 */
function FactField({
	label,
	value,
	hint,
	mono = true,
	variant = "resolved",
	className,
}: {
	label: string;
	value: string;
	hint?: string;
	mono?: boolean;
	variant?: "editable" | "resolved";
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-1 flex-col gap-[5px]", className)}>
			<span className="text-[10px] leading-3 font-medium text-(--color-text-2)">{label}</span>
			<span
				className={cn(
					"flex min-w-0 items-center truncate rounded-(--radius-sm) border px-2.5 py-2 font-mono text-[11px] leading-[14px]",
					variant === "editable"
						? "border-(--color-border-strong) bg-(--color-bg)"
						: "border-(--color-border) bg-(--color-surface-raised)",
					"md:h-8 md:rounded-none md:border-0 md:bg-transparent md:px-0 md:py-0 md:text-[12px] md:leading-4",
					mono ? "" : "md:font-sans",
					value === "—" ? "text-(--color-text-3)" : "text-(--color-text)",
				)}
			>
				{value}
			</span>
			{hint ? (
				<span className="font-mono text-[8px] leading-[10px] tracking-[0.05em] text-(--color-text-3) md:text-[9px] md:leading-3 md:tracking-normal">
					{hint}
				</span>
			) : null}
		</div>
	);
}

/**
 * One section of the instance surface. Below md each section is its
 * own radius-md card headed by a `--color-thead` band; at md+ they
 * collapse back into the single shared card with border-b dividers.
 */
function Section({
	title,
	sub,
	children,
	last = false,
}: {
	title: string;
	sub: string;
	children: React.ReactNode;
	last?: boolean;
}) {
	return (
		<section
			className={cn(
				"flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)",
				"md:gap-3.5 md:overflow-visible md:rounded-none md:border-0 md:p-4",
				!last && "md:border-b md:border-(--color-border)",
			)}
		>
			<div className="flex flex-col gap-[2px] border-b border-(--color-border) bg-(--color-thead) px-3 py-2.5 md:gap-[3px] md:border-b-0 md:bg-transparent md:px-0 md:py-0">
				<h2 className="text-[12px] leading-[15px] font-semibold text-(--color-text) md:leading-4">
					{title}
				</h2>
				<p className="text-[10px] leading-[13px] text-(--color-text-3) md:text-[11px] md:leading-[14px]">
					{sub}
				</p>
			</div>
			<div className="flex flex-col gap-2.5 px-3 py-[11px] md:gap-3.5 md:px-0 md:py-0">
				{children}
			</div>
		</section>
	);
}

/** TOKEN / PUBLIC mode indicator — a read-only display, not a control. */
function AuthModePills({ mode }: { mode: InstanceFactsResponse["authMode"] }) {
	return (
		// Read-only display, not a control: the active mode is highlighted
		// in the raised surface. The visible "Auth mode" label above it
		// carries the accessible name.
		<div className="flex w-max overflow-hidden rounded-(--radius-sm) border border-(--color-border-strong)">
			{(["token", "public"] as const).map((m) => (
				<span
					key={m}
					className={cn(
						"px-3 py-1.5 font-mono text-[10px] leading-3 md:py-2",
						m === mode
							? "bg-(--color-surface-raised) text-(--color-text)"
							: "text-(--color-text-3)",
					)}
				>
					{m.toUpperCase()}
				</span>
			))}
		</div>
	);
}

/**
 * Label/value row in the right-rail facts card. Below md the label is
 * a fixed 110px mono column and the value is right-aligned at full
 * strength; at md+ it reverts to the justify-between row.
 */
function FactRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-2 px-3 py-[7px] md:gap-3 md:px-0 md:py-0">
			<span className="w-[110px] shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3) md:w-auto md:font-sans md:text-[11px] md:leading-[14px]">
				{label}
			</span>
			<span
				className={cn(
					"flex min-w-0 flex-1 justify-end truncate text-right font-mono text-[10px] leading-3",
					"md:block md:text-[11px] md:leading-[14px]",
					value === "—" ? "text-(--color-text-3)" : "text-(--color-text) md:text-(--color-text-2)",
				)}
			>
				{value}
			</span>
		</div>
	);
}

function InstanceSection({ facts }: { facts: InstanceFactsResponse | undefined }) {
	// Facts undefined = still loading: every field renders "—" rather
	// than a spinner-shaped hole; the card is quiet, never fabricated.
	const version = facts ? `v${facts.version}` : "—";
	const runtime = facts ? RUNTIME_LABELS[facts.runtime] : "—";
	const dbBackend = facts?.dbBackend ? facts.dbBackend : "—";

	return (
		<Section title="Instance" sub="Server identity and runtime provider.">
			<div className="grid w-full grid-cols-[1fr_96px] gap-2.5 sm:flex sm:flex-row sm:gap-3">
				<FactField
					label="Runtime provider"
					value={runtime}
					hint="WARREN_RUNTIME · RESOLVED AT BOOT · READ-ONLY"
				/>
				<FactField label="Version" value={version} hint="READ-ONLY" />
			</div>
			<div className="grid w-full grid-cols-2 gap-2.5 sm:flex sm:flex-row sm:gap-3">
				<FactField label="Database backend" value={dbBackend} hint="WARREN_DB_URL · READ-ONLY" />
				<FactField
					label="Instance name / base URL"
					value="—"
					variant="editable"
					hint="NO INSTANCE-NAME API YET · OPS OVERVIEW (WARREN-D903)"
				/>
			</div>
		</Section>
	);
}

function AuthenticationSection({ facts }: { facts: InstanceFactsResponse | undefined }) {
	const authMode = facts?.authMode;
	return (
		<Section title="Authentication" sub="How access is authenticated.">
			<div className="flex flex-col gap-[5px]">
				<span className="text-[10px] leading-3 font-medium text-(--color-text-2)">Auth mode</span>
				{authMode ? (
					<AuthModePills mode={authMode} />
				) : (
					<span className="h-8 font-mono text-[12px] leading-4 text-(--color-text-3)">—</span>
				)}
			</div>
		</Section>
	);
}

function AdmissionSection({ facts }: { facts: InstanceFactsResponse | undefined }) {
	const admission = facts?.admission ?? null;
	return (
		<Section title="Admission" sub="Concurrency and spend caps." last>
			{admission ? (
				<div className="grid w-full grid-cols-2 gap-2.5 sm:flex sm:flex-row sm:gap-3">
					<FactField
						label="Max project concurrency"
						value={
							admission.maxProjectConcurrency === null
								? "unset"
								: String(admission.maxProjectConcurrency)
						}
						hint="WARREN_K8S_MAX_PROJECT_CONCURRENCY"
					/>
					<FactField
						label="Max queue depth"
						value={String(admission.maxQueueDepth)}
						hint="WARREN_K8S_MAX_QUEUE_DEPTH"
					/>
					<FactField
						label="Max pending pods"
						value={String(admission.maxPendingPods)}
						hint="WARREN_K8S_MAX_PENDING_PODS"
						className="col-span-2 sm:col-span-1"
					/>
				</div>
			) : (
				<p className="text-[10px] leading-[14px] text-(--color-text-3)">
					{facts ? "Admission caps are K8s-only — not active under this runtime provider." : "—"}
				</p>
			)}
			<p className="text-[10px] leading-[14px] text-(--color-text-3)">
				Set in the environment, resolved at boot. The admission gate reports them in admission
				events.
			</p>
		</Section>
	);
}

function FactsRail({ facts }: { facts: InstanceFactsResponse | undefined }) {
	const version = facts ? `v${facts.version}` : "—";
	const runtime = facts ? RUNTIME_LABELS[facts.runtime] : "—";
	const dbBackend = facts?.dbBackend ? facts.dbBackend : "—";
	const uptime =
		facts && typeof facts.uptimeSeconds === "number" ? formatUptime(facts.uptimeSeconds) : "—";
	const admission = facts?.admission ?? null;
	// dbBackend is the first operator-only field: its absence marks the
	// reduced spectator projection (warren-2eec).
	const projection = facts
		? facts.dbBackend === undefined
			? "reduced (public)"
			: "full (operator)"
		: "—";

	return (
		<aside className="flex w-full shrink-0 flex-col rounded-(--radius-md) border border-(--color-border) bg-(--color-sidebar) md:bg-(--color-surface) lg:w-[380px]">
			<header className="flex items-center justify-between border-b border-(--color-border) px-3 py-2.5 md:px-4 md:py-3">
				<h2 className="text-[12px] leading-[15px] font-semibold text-(--color-text) md:text-[13px] md:leading-4">
					Instance facts
				</h2>
				<span className="font-mono text-[9px] leading-[11px] tracking-[0.06em] text-(--color-success) md:text-[10px] md:leading-3 md:text-(--color-text-3)">
					LIVE
				</span>
			</header>
			<div className="flex flex-col py-1.5 md:gap-2.5 md:px-4 md:py-3.5">
				<FactRow label="version" value={version} />
				<FactRow label="runtime" value={runtime} />
				<FactRow label="database" value={dbBackend} />
				<FactRow label="uptime" value={uptime} />
				<FactRow
					label="admission caps"
					value={admission ? "k8s · active" : facts ? "not active" : "—"}
				/>
				<FactRow label="spectator projection" value={projection} />
			</div>
		</aside>
	);
}

function InstancePageBody({ facts }: { facts: InstanceFactsResponse | undefined }) {
	return (
		<div className="flex flex-col items-start gap-4 lg:flex-row">
			{/* Main card: the boot-resolved configuration sections. Below md
			 the sections render as separate cards (see Section). */}
			<div className="flex min-w-0 flex-1 flex-col gap-3.5 md:gap-0 md:overflow-clip md:rounded-(--radius-md) md:border md:border-(--color-border) md:bg-(--color-surface)">
				<InstanceSection facts={facts} />
				<AuthenticationSection facts={facts} />
				<AdmissionSection facts={facts} />
			</div>
			{/* Right rail: live facts, one poll. */}
			<FactsRail facts={facts} />
		</div>
	);
}

export function InstancePage() {
	const facts = useQuery({
		queryKey: ["meta", "instance"],
		queryFn: ({ signal }) => metaApi.instance(signal),
		// Boot-resolved values never change without a restart, but uptime
		// ticks: a slow poll keeps the rail honest without hammering.
		refetchInterval: 60_000,
		staleTime: 30_000,
	});

	return (
		<div className="flex min-h-full flex-col gap-3.5 px-3.5 pt-6 pb-12 md:gap-5 md:px-6">
			<header className="flex flex-col gap-1.5">
				<h1 className="text-[17px] leading-[22px] font-semibold tracking-[-0.025em] text-(--color-text) md:text-[22px] md:leading-7">
					Instance
				</h1>
				<p className="max-w-prose text-[11px] leading-[14px] text-(--color-text-2) md:text-[13px] md:leading-[18px]">
					Server settings, read-only. Configure via environment or a project&apos;s
					.warren/config.yaml.
				</p>
			</header>
			<InstancePageBody facts={facts.data} />
		</div>
	);
}
