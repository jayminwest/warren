import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { plotsApi } from "@/api/client.ts";
import type { PlotEnvelope } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

/**
 * IntentPanel — editable goal / non_goals / constraints /
 * success_criteria for a Plot. Disabled when status is done/archived
 * (server also rejects with 409). Draft-restore-on-failure preserves
 * user input across the 5s poll if a save fails (mx-a3798b).
 */

/* ----------------------------------------------------------------------- */
/* IntentPanel                                                              */
/* ----------------------------------------------------------------------- */

export interface IntentDraft {
	goal: string;
	non_goals: string;
	constraints: string;
	success_criteria: string;
}

export function intentToDraft(p: PlotEnvelope): IntentDraft {
	return {
		goal: p.intent.goal,
		non_goals: p.intent.non_goals.join("\n"),
		constraints: p.intent.constraints.join("\n"),
		success_criteria: p.intent.success_criteria.join("\n"),
	};
}

export function splitLines(s: string): string[] {
	return s
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function IntentPanel({ plot, frozen }: { plot: PlotEnvelope; frozen: boolean }) {
	const qc = useQueryClient();
	const [draft, setDraft] = useState<IntentDraft>(() => intentToDraft(plot));
	const [dirty, setDirty] = useState(false);

	// Reconcile draft from server on refetch when the user has no
	// pending edits. Preserve the in-flight draft on dirty so a 5s poll
	// doesn't blow away the user's typing (draft-restore-on-failure
	// pattern from the issue).
	useEffect(() => {
		if (!dirty) setDraft(intentToDraft(plot));
	}, [plot, dirty]);

	const mutation = useMutation({
		mutationFn: () =>
			plotsApi.editIntent(plot.id, {
				goal: draft.goal,
				non_goals: splitLines(draft.non_goals),
				constraints: splitLines(draft.constraints),
				success_criteria: splitLines(draft.success_criteria),
			}),
		onSuccess: (envelope) => {
			qc.setQueryData(["plot", plot.id], envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
			setDirty(false);
			// Draft will resync via the useEffect above on next render.
		},
		// Draft-restore on failure: do nothing — `draft` already holds
		// the user's text, and `dirty` stays true so polling won't
		// clobber it.
	});

	const update = (key: keyof IntentDraft, value: string): void => {
		setDraft((d) => ({ ...d, [key]: value }));
		setDirty(true);
	};

	const reset = (): void => {
		setDraft(intentToDraft(plot));
		setDirty(false);
		mutation.reset();
	};

	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		mutation.mutate();
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Intent</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="intent-goal">Goal</Label>
						<Textarea
							id="intent-goal"
							rows={3}
							value={draft.goal}
							onChange={(e) => update("goal", e.target.value)}
							disabled={frozen || mutation.isPending}
							placeholder="One paragraph describing what this Plot is for…"
						/>
					</div>
					<IntentListField
						id="intent-non_goals"
						label="Non-goals"
						value={draft.non_goals}
						onChange={(v) => update("non_goals", v)}
						disabled={frozen || mutation.isPending}
					/>
					<IntentListField
						id="intent-constraints"
						label="Constraints"
						value={draft.constraints}
						onChange={(v) => update("constraints", v)}
						disabled={frozen || mutation.isPending}
					/>
					<IntentListField
						id="intent-success_criteria"
						label="Success criteria"
						value={draft.success_criteria}
						onChange={(v) => update("success_criteria", v)}
						disabled={frozen || mutation.isPending}
					/>

					{frozen ? (
						<p className="text-xs text-(--color-muted-foreground)">
							Intent is frozen — status <code>{plot.status}</code> does not
							accept edits per SPEC §6.
						</p>
					) : null}

					{mutation.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{mutation.error instanceof Error
								? mutation.error.message
								: String(mutation.error)}
						</p>
					) : null}

					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={reset}
							disabled={!dirty || mutation.isPending}
						>
							Reset
						</Button>
						<Button type="submit" disabled={!dirty || frozen || mutation.isPending}>
							{mutation.isPending ? "Saving…" : "Save"}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

export function IntentListField({
	id,
	label,
	value,
	onChange,
	disabled,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (next: string) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				rows={3}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				placeholder="One item per line"
			/>
			<p className="text-xs text-(--color-muted-foreground)">One item per line.</p>
		</div>
	);
}

