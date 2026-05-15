/**
 * Warren brand mark — burrow network: hexagonal cluster of agent nodes
 * with one active spoke and a control-plane center. Composites on both
 * themes via currentColor, with opacity stops carrying the active /
 * inactive distinction (mirrors branding/generate-logo.py).
 *
 * Geometry is for viewBox 0 0 100 100. Outer-node positions are the
 * 6-point pointed-top hex at radius 32 around (50, 50).
 */
export function WarrenLogo({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 100 100"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<title>warren</title>
			{/* tunnel ring (dim) */}
			<g
				stroke="currentColor"
				strokeWidth={2.2}
				strokeLinecap="round"
				fill="none"
				opacity={0.35}
			>
				<line x1="50" y1="18" x2="77.713" y2="34" />
				<line x1="77.713" y1="34" x2="77.713" y2="66" />
				<line x1="77.713" y1="66" x2="50" y2="82" />
				<line x1="50" y1="82" x2="22.287" y2="66" />
				<line x1="22.287" y1="66" x2="22.287" y2="34" />
				<line x1="22.287" y1="34" x2="50" y2="18" />
			</g>
			{/* inactive spokes */}
			<g
				stroke="currentColor"
				strokeWidth={2.2}
				strokeLinecap="round"
				fill="none"
				opacity={0.55}
			>
				<line x1="50" y1="50" x2="50" y2="18" />
				<line x1="50" y1="50" x2="77.713" y2="66" />
				<line x1="50" y1="50" x2="50" y2="82" />
				<line x1="50" y1="50" x2="22.287" y2="66" />
				<line x1="50" y1="50" x2="22.287" y2="34" />
			</g>
			{/* active spoke (top-right) */}
			<line
				x1="50"
				y1="50"
				x2="77.713"
				y2="34"
				stroke="currentColor"
				strokeWidth={2.2}
				strokeLinecap="round"
			/>
			{/* outer nodes (inactive) */}
			<g fill="currentColor" opacity={0.55}>
				<circle cx="50" cy="18" r="4.5" />
				<circle cx="77.713" cy="66" r="4.5" />
				<circle cx="50" cy="82" r="4.5" />
				<circle cx="22.287" cy="66" r="4.5" />
				<circle cx="22.287" cy="34" r="4.5" />
			</g>
			{/* active outer node */}
			<circle cx="77.713" cy="34" r="4.5" fill="currentColor" />
			{/* control plane */}
			<rect x="42" y="42" width="16" height="16" rx="2.8" fill="currentColor" opacity={0.85} />
		</svg>
	);
}
