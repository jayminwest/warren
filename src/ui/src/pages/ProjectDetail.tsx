import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, projectsApi } from "@/api/client.ts";
import type {
	DefaultsConfig,
	ProjectRow,
	RunTriggerResponse,
	TriggerSummary,
	WarrenConfigFileError,
	WarrenConfigResponse,
} from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	cardVariants,
} from "@/components/ui/card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { cn, formatTimestamp } from "@/lib/utils.ts";

export function ProjectDetailPage() {
	const { id = "" } = useParams<{ id: string }>();

	// Reuse the projects-list cache rather than introducing a GET /projects/:id —
	// the list endpoint is the only project-row source today (warren-435b shipped
	// only the warren-config sub-resource), and the projects page primes this
	// cache on the way in.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const warrenConfig = useQuery({
		queryKey: ["projects", id, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(id, signal),
		enabled: id.length > 0,
	});

	const project: ProjectRow | undefined = projects.data?.projects.find((p) => p.id === id);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
						<Link to="/projects">
							<ArrowLeft className="h-4 w-4" />
							Projects
						</Link>
					</Button>
					<h1 className="font-mono text-xl font-semibold">{id}</h1>
					{project ? (
						<p className="mt-1 font-mono text-xs text-(--color-muted-foreground)">
							{project.gitUrl}
						</p>
					) : null}
				</div>
			</header>

			{projects.isLoading ? (
				<Spinner label="Loading project" />
			) : projects.isError ? (
				<Alert variant="danger" title="Failed to load project">
					{formatError(projects.error)}
				</Alert>
			) : project === undefined ? (
				<Alert variant="danger" title="Project not found" />
			) : (
				<>
					<ProjectMetaCard project={project} />
					<WarrenConfigPanel
						projectId={id}
						query={warrenConfig.data}
						isLoading={warrenConfig.isLoading}
						error={warrenConfig.error}
					/>
				</>
			)}
		</div>
	);
}

function ProjectMetaCard({ project }: { project: ProjectRow }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Project</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
					<MetaRow label="Local path" value={<code className="text-xs">{project.localPath}</code>} />
					<MetaRow label="Default branch" value={project.defaultBranch} />
					<MetaRow
						label="Last HEAD"
						value={
							<code
								className="text-xs"
								title={project.lastHeadSha ?? "never fetched"}
							>
								{project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 12) : "—"}
							</code>
						}
					/>
					<MetaRow
						label="Last fetched"
						value={
							project.lastFetchedAt !== null
								? formatTimestamp(project.lastFetchedAt)
								: "never"
						}
					/>
					<MetaRow label="Added" value={formatTimestamp(project.addedAt)} />
				</dl>
			</CardContent>
		</Card>
	);
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-baseline gap-3">
			<dt className="w-32 shrink-0 text-(--color-muted-foreground)">{label}</dt>
			<dd className="min-w-0 break-all">{value}</dd>
		</div>
	);
}

function WarrenConfigPanel({
	projectId,
	query,
	isLoading,
	error,
}: {
	projectId: string;
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	error: unknown;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-baseline justify-between gap-3">
					<CardTitle>
						<span className="mr-2">Warren config</span>
						<code className="text-xs font-normal text-(--color-muted-foreground)">.warren/</code>
					</CardTitle>
					{query !== undefined && query.errors.length > 0 ? (
						<Badge variant="failed" className="font-mono text-xs">
							{query.errors.length} error{query.errors.length === 1 ? "" : "s"}
						</Badge>
					) : null}
				</div>
			</CardHeader>
			<CardContent className="space-y-6">
				{isLoading ? (
					<Spinner label="Loading warren config" />
				) : error !== null && error !== undefined ? (
					<WarrenConfigError error={error} />
				) : query === undefined ? null : (
					<>
						<TriggersBlock projectId={projectId} />
						<DefaultsBlock defaults={query.defaults} sourceFile={query.sourceFile} />
						{query.errors.length > 0 ? <ErrorsBlock errors={query.errors} /> : null}
					</>
				)}
			</CardContent>
		</Card>
	);
}

function WarrenConfigError({ error }: { error: unknown }) {
	if (error instanceof ApiError && error.status === 503) {
		return (
			<Alert variant="danger" title={error.message}>
				{error.hint !== undefined ? (
					<span className="text-xs">{error.hint}</span>
				) : null}
			</Alert>
		);
	}
	return <Alert variant="danger">{formatError(error)}</Alert>;
}

function TriggersBlock({ projectId }: { projectId: string }) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// /projects/:id/triggers joins parsed YAML with the warren-side triggers
	// table for last/next/lastRunId, plus a fresh croner re-parse per request
	// — richer envelope than /warren-config's plain Trigger[] (mx-a93eb5).
	const triggersQuery = useQuery({
		queryKey: ["projects", projectId, "triggers"],
		queryFn: ({ signal }) => projectsApi.triggers(projectId, signal),
		enabled: projectId.length > 0,
	});

	const runNow = useMutation({
		mutationFn: (triggerId: string) => projectsApi.runTrigger(projectId, triggerId),
		onSuccess: (data: RunTriggerResponse) => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "triggers"] });
			qc.invalidateQueries({ queryKey: ["runs"] });
			navigate(`/runs/${encodeURIComponent(data.run.id)}`);
		},
	});

	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold">
				<code className="font-mono">.warren/triggers.yaml</code>
			</h3>
			{triggersQuery.isLoading ? (
				<EmptyHint text="Loading…" />
			) : triggersQuery.isError ? (
				<Alert variant="danger">{formatError(triggersQuery.error)}</Alert>
			) : triggersQuery.data === undefined || triggersQuery.data.triggers.length === 0 ? (
				<EmptyHint text="No triggers configured (edit .warren/triggers.yaml on the project repo to add one)." />
			) : (
				<ul className="space-y-2">
					{triggersQuery.data.triggers.map((t) => (
						<TriggerRow
							key={t.id}
							trigger={t}
							isRunning={runNow.isPending && runNow.variables === t.id}
							onRunNow={() => runNow.mutate(t.id)}
							runError={
								runNow.isError && runNow.variables === t.id
									? formatError(runNow.error)
									: null
							}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function TriggerRow({
	trigger,
	isRunning,
	onRunNow,
	runError,
}: {
	trigger: TriggerSummary;
	isRunning: boolean;
	onRunNow: () => void;
	runError: string | null;
}) {
	return (
		<li
			className={cn(
				cardVariants({ variant: "flat" }),
				"bg-(--color-muted)/30 px-3 py-2 text-sm",
			)}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-baseline gap-2">
					<span className="font-mono font-semibold">{trigger.id}</span>
					<Badge variant="secondary" className="font-mono text-xs">
						{trigger.kind}
					</Badge>
					<code className="text-xs text-(--color-muted-foreground)">{trigger.cron}</code>
					{trigger.timezone !== undefined ? (
						<span className="text-xs text-(--color-muted-foreground)">
							tz: {trigger.timezone}
						</span>
					) : null}
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onRunNow}
					disabled={isRunning}
				>
					{isRunning ? "Dispatching…" : "Run now"}
				</Button>
			</div>
			<dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
				{trigger.seed !== undefined ? (
					<>
						<dt className="text-(--color-muted-foreground)">seed</dt>
						<dd className="font-mono">{trigger.seed}</dd>
					</>
				) : null}
				<dt className="text-(--color-muted-foreground)">role</dt>
				<dd className="font-mono">{trigger.role}</dd>
				{trigger.prompt !== undefined ? (
					<>
						<dt className="text-(--color-muted-foreground)">prompt</dt>
						<dd className="break-words">{trigger.prompt}</dd>
					</>
				) : null}
				<dt className="text-(--color-muted-foreground)">last fired</dt>
				<dd>
					{trigger.lastFiredAt !== null ? (
						trigger.lastRunId !== null ? (
							<Link
								to={`/runs/${encodeURIComponent(trigger.lastRunId)}`}
								className="underline-offset-2 hover:underline"
								title={trigger.lastRunId}
							>
								{formatTimestamp(trigger.lastFiredAt)}
							</Link>
						) : (
							formatTimestamp(trigger.lastFiredAt)
						)
					) : (
						<span className="text-(--color-muted-foreground)">never</span>
					)}
				</dd>
				<dt className="text-(--color-muted-foreground)">next fire</dt>
				<dd>
					{trigger.nextFireAt !== null ? (
						formatTimestamp(trigger.nextFireAt)
					) : (
						<span className="text-(--color-muted-foreground)">—</span>
					)}
				</dd>
			</dl>
			{trigger.parseError !== null ? (
				<p className="mt-1.5 text-xs text-(--color-destructive)">
					cron parse error: {trigger.parseError}
				</p>
			) : null}
			{runError !== null ? (
				<p className="mt-1.5 text-xs text-(--color-destructive)">{runError}</p>
			) : null}
		</li>
	);
}

function DefaultsBlock({
	defaults,
	sourceFile,
}: { defaults: DefaultsConfig | null; sourceFile: string | null }) {
	const isEmpty =
		defaults !== null &&
		defaults.defaultRole === undefined &&
		defaults.defaultBranch === undefined &&
		defaults.defaultPrompt === undefined;
	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold">
				<code className="font-mono">{sourceFile ?? ".warren/config.yaml"}</code>
			</h3>
			{defaults === null ? (
				<EmptyHint text="Not present (or last load failed — see errors below)." />
			) : isEmpty ? (
				<EmptyHint text="File is present but sets no overrides." />
			) : (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
					{defaults.defaultRole !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultRole</dt>
							<dd className="font-mono">{defaults.defaultRole}</dd>
						</>
					) : null}
					{defaults.defaultBranch !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultBranch</dt>
							<dd className="font-mono">{defaults.defaultBranch}</dd>
						</>
					) : null}
					{defaults.defaultPrompt !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultPrompt</dt>
							<dd className="break-words">{defaults.defaultPrompt}</dd>
						</>
					) : null}
					{defaults.runBranchPrefix !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">runBranchPrefix</dt>
							<dd className="font-mono">{defaults.runBranchPrefix}</dd>
						</>
					) : null}
				</dl>
			)}
		</section>
	);
}

function ErrorsBlock({ errors }: { errors: WarrenConfigFileError[] }) {
	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold text-(--color-destructive)">
				Validation errors
			</h3>
			<ul className="space-y-2">
				{errors.map((e) => (
					<li
						key={`${e.file}:${e.code}`}
						className="rounded-md border border-(--color-destructive)/40 bg-(--color-destructive)/5 px-3 py-2 text-sm"
					>
						<div className="flex flex-wrap items-baseline gap-2">
							<code className="font-mono text-xs">{e.file}</code>
							<Badge variant="failed" className="font-mono text-xs">
								{e.code}
							</Badge>
						</div>
						<p className="mt-1 break-words text-xs">{e.message}</p>
					</li>
				))}
			</ul>
		</section>
	);
}

function EmptyHint({ text }: { text: string }) {
	return <p className="text-sm text-(--color-muted-foreground)">{text}</p>;
}
