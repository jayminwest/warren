/**
 * Token KPI cards and per-model / per-provider token stats tables for
 * the Run Analytics dashboard (warren-bbc6 / pl-d1a2 step 5).
 *
 * TokenKpiCards renders three summary cards sourced from
 * `tokens.totals`: total tokens, input/output split, and cache-read
 * share. Zeroes are shown (not NaN) when the window is empty.
 *
 * TokenGroupTable renders one row per model or provider bucket with
 * columns for each token kind, share-of-total, and cost per 1M tokens
 * (derived from the bucket's costUsd + tokens.total; divide-by-zero
 * guarded → '—'). Uses the RunGroupBucket shape (which carries both
 * tokens and costUsd) so no extra fetch is needed.
 */
import { RUN_ANALYTICS_NONE_KEY, type RunGroupBucket } from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatCostUsd, formatPercent, formatTokens, formatTokensOrDash } from "./format.ts";

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

function TokenKpiCard({
	title,
	value,
	hint,
}: {
	title: string;
	value: React.ReactNode;
	hint?: React.ReactNode;
}) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-xs font-medium text-(--color-muted-foreground)">
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="font-mono text-2xl">{value}</div>
				{hint !== undefined ? (
					<p className="mt-1 text-xs text-(--color-muted-foreground)">{hint}</p>
				) : null}
			</CardContent>
		</Card>
	);
}

export function TokenKpiCards({
	totals,
}: {
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined;
}) {
	const dash = "—";

	const total = totals?.total ?? 0;
	const input = totals?.input ?? 0;
	const output = totals?.output ?? 0;
	const cacheRead = totals?.cacheRead ?? 0;
	const cacheReadShare = total > 0 ? cacheRead / total : null;

	return (
		<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
			<TokenKpiCard
				title="Total tokens"
				value={totals === undefined ? dash : formatTokens(total)}
				hint={
					totals === undefined
						? undefined
						: `input ${formatTokensOrDash(input)} · output ${formatTokensOrDash(output)}`
				}
			/>
			<TokenKpiCard
				title="Input / Output split"
				value={
					totals === undefined
						? dash
						: total === 0
							? "—"
							: `${formatPercent(input / total)} in`
				}
				hint={
					totals === undefined
						? undefined
						: total === 0
							? undefined
							: `${formatPercent(output / total)} output`
				}
			/>
			<TokenKpiCard
				title="Cache-read share"
				value={totals === undefined ? dash : formatPercent(cacheReadShare)}
				hint={
					totals === undefined
						? undefined
						: `${formatTokensOrDash(cacheRead)} cache-read tokens`
				}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Per-model / per-provider token stats table
// ---------------------------------------------------------------------------

function renderBucketKey(_dimension: "model" | "provider", key: string): React.ReactNode {
	if (key === RUN_ANALYTICS_NONE_KEY) {
		return <span className="text-(--color-muted-foreground)">—</span>;
	}
	return <span className="font-mono text-xs">{key}</span>;
}

/** Cost per 1M tokens, guarding divide-by-zero. */
function costPer1M(costUsd: number, total: number): string {
	if (total === 0) return "—";
	return formatCostUsd((costUsd / total) * 1_000_000);
}

export function TokenGroupTable({
	title,
	subtitle,
	dimension,
	buckets,
	loading,
}: {
	title: string;
	subtitle: string;
	dimension: "model" | "provider";
	buckets: RunGroupBucket[];
	loading: boolean;
}) {
	const grandTotal = buckets.reduce((s, b) => s + b.tokens.total, 0);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">{subtitle}</p>
			</CardHeader>
			<CardContent>
				{loading ? (
					<p className="text-sm text-(--color-muted-foreground)">Loading…</p>
				) : buckets.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">No data in this window.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{dimension === "model" ? "Model" : "Provider"}</TableHead>
								<TableHead className="text-right">Input</TableHead>
								<TableHead className="text-right">Output</TableHead>
								<TableHead className="text-right">Cache R</TableHead>
								<TableHead className="text-right">Cache W</TableHead>
								<TableHead className="text-right">Total</TableHead>
								<TableHead className="text-right">Share</TableHead>
								<TableHead className="text-right">$/1M</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{buckets.map((b) => (
								<TableRow key={b.key}>
									<TableCell className="max-w-[200px] truncate">
										{renderBucketKey(dimension, b.key)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{formatTokens(b.tokens.input)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{formatTokens(b.tokens.output)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{formatTokens(b.tokens.cacheRead)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
										{formatTokens(b.tokens.cacheWrite)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs font-medium">
										{formatTokens(b.tokens.total)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{grandTotal === 0 ? "—" : formatPercent(b.tokens.total / grandTotal)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-right font-mono text-xs">
										{costPer1M(b.costUsd, b.tokens.total)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
