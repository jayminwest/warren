import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { CardFooter } from "@/components/ui/card.tsx";
import { Select } from "@/components/ui/select.tsx";

/**
 * Runs list footer (warren-9474). From `md` it is the page pager: rows
 * per page, the all-time cost, the visible range, and prev/next. On a
 * phone it is the count plus a Load more button that grows the card
 * window.
 */
export function RunsPager({
	pageSize,
	pageSizeOptions,
	onPageSize,
	rangeStart,
	rangeEnd,
	total,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	costLabel,
	costTitle,
	mobileShown,
	mobileHasMore,
	onMore,
}: {
	pageSize: number;
	pageSizeOptions: readonly number[];
	onPageSize: (n: number) => void;
	rangeStart: number;
	rangeEnd: number;
	total: number;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev: () => void;
	onNext: () => void;
	costLabel: string | null;
	costTitle?: string;
	mobileShown: number;
	mobileHasMore: boolean;
	onMore: () => void;
}) {
	return (
		<CardFooter className="flex-wrap">
			<span className="tabular-nums md:hidden">
				{mobileShown} of {total}
			</span>
			{mobileHasMore ? (
				<Button variant="outline" size="sm" className="md:hidden" onClick={onMore}>
					Load more
				</Button>
			) : null}
			<div className="hidden items-center gap-2 md:flex">
				<span id="runs-page-size-label">Rows per page</span>
				<Select
					aria-labelledby="runs-page-size-label"
					value={pageSize}
					onChange={(e) => onPageSize(Number.parseInt(e.target.value, 10))}
					className="sm:h-7 sm:text-xs"
				>
					{pageSizeOptions.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</Select>
			</div>
			<div className="hidden items-center gap-4 md:flex">
				{costLabel !== null ? (
					<span className="tabular-nums" title={costTitle}>
						{costLabel} all time
					</span>
				) : null}
				<span className="tabular-nums">
					{rangeStart}–{rangeEnd} of {total}
				</span>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						disabled={!hasPrev}
						onClick={onPrev}
						aria-label="Previous page"
					>
						<ChevronLeft />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						disabled={!hasNext}
						onClick={onNext}
						aria-label="Next page"
					>
						<ChevronRight />
					</Button>
				</div>
			</div>
		</CardFooter>
	);
}
