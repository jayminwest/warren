/**
 * Recent control-plane events panel (warren-d903). A quiet placeholder,
 * not a fabricated feed: the global events query API (pl-7e38 step 15,
 * warren-5eec) does not exist yet, and the only live surface —
 * `GET /events/stream` — is a no-replay follow stream the shell already
 * holds one connection to (warren-f566's one-connection-per-tab rule),
 * so this page does not open a second one just to show a partial tail.
 */

export function EventsPanel() {
	return (
		<div className="flex min-w-[320px] flex-1 flex-col">
			<header className="flex h-7 shrink-0 items-center pb-1.25">
				<h2 className="text-[11px] leading-3.5 font-semibold text-(--color-text-2)">
					Control-plane events
				</h2>
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					STRUCTURED EVENT LOG
				</span>
			</header>
			<div className="flex flex-1 flex-col justify-center overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
				<p className="px-3 py-4 font-mono text-[10px] leading-4 text-(--color-text-3)">
					The global event query API lands with warren-5eec; the Event explorer (warren-24b9) will
					carry the full structured feed. The live lifecycle stream already refreshes every figure
					on this page.
				</p>
			</div>
		</div>
	);
}
