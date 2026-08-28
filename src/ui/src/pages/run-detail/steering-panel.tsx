import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { runsApi } from "@/api/client.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The Direction C steering inbox (warren-8c85 / pl-7e38 step 4) and the
 * cancel-run header action. Both mutate, so both mount only inside
 * OperatorOnly — the spectator projection never renders them.
 */

export function SteerForm({ runId, disabled }: { runId: string; disabled: boolean }) {
	const [body, setBody] = useState("");
	const [success, setSuccess] = useState(false);

	const steer = useMutation({
		mutationFn: () => runsApi.steer(runId, { body }),
		onSuccess: () => {
			setBody("");
			setSuccess(true);
			window.setTimeout(() => setSuccess(false), 3000);
		},
	});

	return (
		<section className="flex shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[39px] shrink-0 items-center border-b border-(--color-border) px-3">
				<h2 className="text-[11px] leading-[14px] font-semibold text-(--color-text)">
					Steering inbox
				</h2>
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{disabled ? "CLOSED" : body.trim().length > 0 ? "DRAFT" : "EMPTY"}
				</span>
			</header>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (body.trim().length === 0) return;
					steer.mutate();
				}}
				className="flex items-end gap-[7px] p-3 max-md:items-center"
			>
				<textarea
					rows={3}
					value={body}
					onChange={(e) => setBody(e.target.value)}
					disabled={disabled}
					placeholder={
						disabled
							? "Run is terminal; steering is closed."
							: "Message the agent at its next turn boundary."
					}
					/*
					 * Mobile (warren-ecd8): single-line composer below md — a
					 * one-row input beside the filled Send, per the mock's
					 * steering-inbox block. md+ keeps the 3-row textarea.
					 */
					className="min-h-0 flex-1 resize-none rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-bg) px-2.5 py-2 text-[11px] leading-4 text-(--color-text-2) placeholder:text-(--color-text-3) max-md:h-[36px] max-md:py-0 max-md:leading-[14px]"
				/>
				<button
					type="submit"
					disabled={disabled || steer.isPending || body.trim().length === 0}
					className={cn(
						"inline-flex h-[31px] shrink-0 items-center rounded-(--radius-sm) px-[11px] text-[11px] leading-[14px] font-medium max-md:h-[36px]",
						disabled || steer.isPending || body.trim().length === 0
							? "bg-(--color-primary)/40 text-(--color-primary-ink)"
							: "bg-(--color-primary) text-(--color-primary-ink) hover:opacity-90",
					)}
				>
					{steer.isPending ? "Sending…" : "Send"}
				</button>
			</form>
			{steer.isError ? (
				<p className="px-3 pb-3 font-mono text-[9px] leading-3 text-(--color-danger)">
					{steer.error instanceof Error ? steer.error.message : String(steer.error)}
				</p>
			) : null}
			{success ? (
				<p className="px-3 pb-3 font-mono text-[9px] leading-3 text-(--color-success)">
					Steering message delivered.
				</p>
			) : null}
		</section>
	);
}

export function CancelRunButton({
	runId,
	disabled,
	onSettled,
	mobile,
}: {
	runId: string;
	disabled: boolean;
	onSettled: () => void;
	/** Text affordance for the mobile header row (warren-ecd8). */
	mobile?: boolean;
}) {
	const cancel = useMutation({
		mutationFn: () => runsApi.cancel(runId, {}),
		onSettled,
	});
	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={() => cancel.mutate()}
				disabled={cancel.isPending || disabled}
				className={
					mobile
						? "font-mono text-[11px] leading-[14px] font-medium text-(--color-danger) disabled:opacity-50"
						: "inline-flex h-[31px] items-center gap-1.5 rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] text-[11px] leading-[14px] font-medium text-(--color-danger) hover:bg-(--color-surface-hover) disabled:opacity-50"
				}
			>
				■ {cancel.isPending ? "Cancelling…" : mobile ? "Cancel" : "Cancel run"}
			</button>
			{cancel.isError ? (
				<p className="font-mono text-[9px] leading-3 text-(--color-danger)">
					{cancel.error instanceof Error ? cancel.error.message : String(cancel.error)}
				</p>
			) : null}
			{cancel.isSuccess && cancel.data !== undefined ? (
				<p className="font-mono text-[9px] leading-3 text-(--color-muted-foreground)">
					{cancel.data.alreadyTerminal
						? `Run was already terminal (${cancel.data.state}).`
						: `Cancel forwarded${cancel.data.sandboxRun?.state !== undefined ? ` (sandbox: ${cancel.data.sandboxRun.state})` : ""}.`}
				</p>
			) : null}
		</div>
	);
}
