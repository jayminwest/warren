import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
	ArrowRight,
	FolderGit2,
	Keyboard,
	Layers,
	LogIn,
	LogOut,
	Moon,
	Plus,
	Search,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { planRunsApi, projectsApi, runsApi, setApiToken } from "@/api/client.ts";
import { CHORD_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { Kbd } from "@/components/ui/kbd.tsx";
import { StatusDot } from "@/components/ui/status.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { useTheme } from "@/hooks/use-theme.ts";
import { activityLine, shortRepo } from "@/pages/operations/operations.helpers.ts";

/**
 * ⌘K command palette (warren-a8c9). Jump anywhere, open a run, plan run
 * or project by name or id, start a dispatch, flip the theme. Loaded
 * lazily by the shell, so cmdk stays out of the first-load bundle. The
 * run and plan-run reads fire only while the palette is open.
 */

const ID_PATTERN = /^(run|plnr|prj)_[a-z0-9]+$/i;

function idTarget(id: string): string {
	if (id.startsWith("plnr_")) return `/plan-runs/${id}`;
	if (id.startsWith("prj_")) return `/projects/${id}`;
	return `/runs/${id}`;
}

export default function CommandPalette({
	open,
	onOpenChange,
	onOpenHelp,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenHelp: () => void;
}) {
	const navigate = useNavigate();
	const caps = useCapabilities();
	const qc = useQueryClient();
	const { resolvedTheme, setTheme } = useTheme();
	const [search, setSearch] = useState("");

	const runs = useQuery({
		queryKey: ["runs", "palette"],
		queryFn: ({ signal }) => runsApi.list({ sort: "started", dir: "desc", limit: 40 }, signal),
		enabled: open,
		staleTime: 15_000,
	});
	const planRuns = useQuery({
		queryKey: ["plan-runs"],
		queryFn: ({ signal }) => planRunsApi.list({}, signal),
		enabled: open,
		staleTime: 15_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		enabled: open,
		staleTime: 60_000,
	});

	useEffect(() => {
		if (!open) setSearch("");
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onOpenChange(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onOpenChange]);

	if (!open) return null;

	const go = (to: string): void => {
		onOpenChange(false);
		navigate(to);
	};
	const trimmed = search.trim();
	const canDispatch = caps.can("dispatch");
	const isOperator = caps.can("readOperator");
	const projectList = projects.data?.projects ?? [];
	const repoOf = new Map(projectList.map((p) => [p.id, shortRepo(p.gitUrl)]));

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; Escape closes too
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px] animate-fade-in"
			onMouseDown={() => onOpenChange(false)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop dismiss */}
			<div className="w-full max-w-xl animate-pop-in" onMouseDown={(e) => e.stopPropagation()}>
				<Command
					label="Command palette"
					loop
					className="overflow-hidden rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-2xl"
				>
					<div className="flex items-center gap-2.5 border-b border-(--color-border) px-3.5">
						<Search aria-hidden className="size-4 text-(--color-text-3)" />
						<Command.Input
							autoFocus
							value={search}
							onValueChange={setSearch}
							placeholder="Search runs, plans, projects, or jump to a page"
							className="h-12 flex-1 bg-transparent text-base text-(--color-text) outline-none placeholder:text-(--color-text-3)"
						/>
						<Kbd>Esc</Kbd>
					</div>
					<Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-(--color-text-3)">
						<Command.Empty className="px-3 py-10 text-center text-sm text-(--color-text-3)">
							No matches.
						</Command.Empty>

						{ID_PATTERN.test(trimmed) ? (
							<Command.Group heading="Jump to id">
								<Item
									icon={<ArrowRight className="size-4" />}
									value={`jump ${trimmed}`}
									onSelect={() => go(idTarget(trimmed))}
								>
									Open <span className="font-mono text-xs">{trimmed}</span>
								</Item>
							</Command.Group>
						) : null}

						{canDispatch ? (
							<Command.Group heading="Dispatch">
								<Item
									icon={<Plus className="size-4" />}
									value="new run dispatch agent"
									shortcut="C"
									onSelect={() => go("/dispatch")}
								>
									New run
								</Item>
								<Item
									icon={<Layers className="size-4" />}
									value="new plan run dispatch"
									onSelect={() => go("/dispatch/plan")}
								>
									New plan run
								</Item>
							</Command.Group>
						) : null}

						<Command.Group heading="Go to">
							{CHORD_NAV_ITEMS.map((item) => {
								const Icon = item.icon;
								return (
									<Item
										key={item.to}
										icon={<Icon className="size-4" />}
										value={`go ${item.label}`}
										shortcut={item.key ? `G ${item.key.toUpperCase()}` : undefined}
										onSelect={() => go(item.to)}
									>
										{item.label}
									</Item>
								);
							})}
						</Command.Group>

						{trimmed.length > 0 ? (
							<>
								<Command.Group heading="Runs">
									{(runs.data?.runs ?? []).map((r) => {
										const repo = r.projectId ? repoOf.get(r.projectId) : undefined;
										const title = r.seedId ?? activityLine(r.prompt);
										return (
											<Item
												key={r.id}
												icon={<StatusDot state={r.state} />}
												value={`${title} ${r.id} ${r.agentName} ${repo ?? ""} ${activityLine(r.prompt)}`}
												meta={<span className="font-mono text-xs">{r.id.slice(0, 12)}</span>}
												onSelect={() => go(`/runs/${r.id}`)}
											>
												<span className="truncate">{title}</span>
												{repo ? (
													<span className="shrink-0 text-(--color-text-3)">{repo}</span>
												) : null}
											</Item>
										);
									})}
								</Command.Group>
								<Command.Group heading="Plan runs">
									{(planRuns.data?.planRuns ?? []).slice(0, 30).map((p) => (
										<Item
											key={p.id}
											icon={<StatusDot state={p.state} />}
											value={`plan ${p.planId ?? ""} ${p.id} ${p.agentName}`}
											meta={<span className="font-mono text-xs">{p.id.slice(0, 13)}</span>}
											onSelect={() => go(`/plan-runs/${p.id}`)}
										>
											<span className="truncate">Plan {p.planId ?? "(issue list)"}</span>
											<span className="shrink-0 text-(--color-text-3)">
												{repoOf.get(p.projectId) ?? ""}
											</span>
										</Item>
									))}
								</Command.Group>
								<Command.Group heading="Projects">
									{projectList.map((p) => (
										<Item
											key={p.id}
											icon={<FolderGit2 className="size-4" />}
											value={`project ${shortRepo(p.gitUrl)} ${p.id}`}
											onSelect={() => go(`/projects/${p.id}`)}
										>
											{shortRepo(p.gitUrl)}
										</Item>
									))}
								</Command.Group>
							</>
						) : null}

						<Command.Group heading="Preferences">
							<Item
								icon={<Moon className="size-4" />}
								value="toggle theme dark light"
								shortcut="⇧ T"
								onSelect={() => {
									setTheme(resolvedTheme === "dark" ? "light" : "dark");
									onOpenChange(false);
								}}
							>
								Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
							</Item>
							<Item
								icon={<Keyboard className="size-4" />}
								value="keyboard shortcuts help"
								shortcut="?"
								onSelect={() => {
									onOpenChange(false);
									onOpenHelp();
								}}
							>
								Keyboard shortcuts
							</Item>
							{isOperator ? (
								<Item
									icon={<LogOut className="size-4" />}
									value="log out sign out"
									onSelect={() => {
										setApiToken(null);
										qc.clear();
										go("/login");
									}}
								>
									Log out
								</Item>
							) : (
								<Item
									icon={<LogIn className="size-4" />}
									value="log in sign in token"
									onSelect={() => go("/login")}
								>
									Log in
								</Item>
							)}
						</Command.Group>
					</Command.List>
					<div className="flex items-center gap-3 border-t border-(--color-border) px-3.5 py-2 text-xs text-(--color-text-3)">
						<span className="flex items-center gap-1">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd>
							move
						</span>
						<span className="flex items-center gap-1">
							<Kbd>↵</Kbd>
							open
						</span>
					</div>
				</Command>
			</div>
		</div>
	);
}

function Item({
	icon,
	children,
	onSelect,
	shortcut,
	value,
	meta,
}: {
	icon: ReactNode;
	children: ReactNode;
	onSelect: () => void;
	shortcut?: string | undefined;
	value: string;
	meta?: ReactNode;
}) {
	return (
		<Command.Item
			value={value}
			onSelect={onSelect}
			className="flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm text-(--color-text-2) data-[selected=true]:bg-(--color-surface-raised) data-[selected=true]:text-(--color-text)"
		>
			<span className="flex size-4 shrink-0 items-center justify-center text-(--color-text-3)">
				{icon}
			</span>
			<span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
			{meta ? <span className="shrink-0 text-(--color-text-3)">{meta}</span> : null}
			{shortcut ? (
				<span className="flex shrink-0 gap-1">
					{shortcut.split(" ").map((k) => (
						<Kbd key={k}>{k}</Kbd>
					))}
				</span>
			) : null}
		</Command.Item>
	);
}
