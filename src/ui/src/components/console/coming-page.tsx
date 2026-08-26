/**
 * Minimal titled stub for Direction C routes whose page issue has not
 * landed yet (warren-4ed7). It names the coming page and the issue that
 * builds it — a placeholder, never a fabricated data surface.
 */
export function ComingPage({
	title,
	summary,
	issueId,
}: {
	title: string;
	summary: string;
	issueId: string;
}) {
	return (
		<div className="flex min-h-full flex-col gap-1.5 px-6 pt-5 pb-12 sm:px-[22px]">
			<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
				{title}
			</h1>
			<p className="max-w-prose text-[12px] leading-4 text-(--color-text-2)">{summary}</p>
			<p className="mt-1 font-mono text-[10px] leading-3 text-(--color-text-3)">
				lands with {issueId}
			</p>
		</div>
	);
}
