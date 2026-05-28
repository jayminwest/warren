import {
	AnimatePresence,
	type HTMLMotionProps,
	LazyMotion,
	MotionConfig,
	domAnimation,
	m,
	useReducedMotion,
} from "framer-motion";
import * as React from "react";

/*
 * Phase 5 motion layer (warren-5da1 / pl-55a3 step 6):
 *
 * Lightweight wrappers over framer-motion that drive staggered entry
 * (lists), event-stream item animations (NDJSON tail in RunDetail),
 * and dialog/skeleton transitions. Everything is gated behind the
 * user's prefers-reduced-motion via `MotionConfig reducedMotion="user"`
 * mounted at the app root — framer-motion natively collapses transforms
 * and opacity transitions to instant when the media query is set, so
 * users with reduce-motion see no movement, only the final state.
 *
 * Bundle-size discipline: we import `m` (the tree-shakable motion proxy)
 * + `domAnimation` features via `LazyMotion`, NOT the full `motion`
 * proxy. That keeps the framer-motion footprint to the opacity/transform
 * subset we actually use.
 */

const FADE_IN_VARIANTS = {
	hidden: { opacity: 0, y: 4 },
	visible: { opacity: 1, y: 0 },
} as const;

const STAGGER_PARENT_VARIANTS = {
	hidden: {},
	visible: {
		transition: {
			staggerChildren: 0.04,
			delayChildren: 0.02,
		},
	},
} as const;

const DEFAULT_TRANSITION = { duration: 0.18, ease: "easeOut" } as const;

/**
 * Mount once at the app root. `reducedMotion="user"` makes every
 * descendant motion component respect the user's OS-level
 * prefers-reduced-motion setting (transforms/opacity become instant).
 *
 * `LazyMotion strict` swaps the full `motion` proxy for the smaller
 * `m` component + `domAnimation` feature bundle (warren-5da1) — about
 * a third of the size of the full feature set, and the features we
 * skipped (drag, layout animations, complex SVG) aren't on the Phase 5
 * surface. `strict` makes any accidental `motion.div` import throw
 * loudly so the bundle stays small.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
	return (
		<MotionConfig reducedMotion="user" transition={DEFAULT_TRANSITION}>
			<LazyMotion features={domAnimation} strict>
				{children}
			</LazyMotion>
		</MotionConfig>
	);
}

export type FadeInProps = HTMLMotionProps<"div">;

/**
 * Fade + tiny rise-up. Use for one-shot entry of a card/page section.
 * Respects reduce-motion via MotionConfig.
 */
export const FadeIn = React.forwardRef<HTMLDivElement, FadeInProps>(
	({ children, ...rest }, ref) => (
		<m.div
			ref={ref}
			variants={FADE_IN_VARIANTS}
			initial="hidden"
			animate="visible"
			exit="hidden"
			{...rest}
		>
			{children}
		</m.div>
	),
);
FadeIn.displayName = "FadeIn";

/**
 * Container that staggers its direct `FadeInItem` children on mount.
 * The children inherit the visible variant via the parent's orchestration.
 */
export const StaggerList = React.forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
	({ children, ...rest }, ref) => (
		<m.div
			ref={ref}
			variants={STAGGER_PARENT_VARIANTS}
			initial="hidden"
			animate="visible"
			{...rest}
		>
			{children}
		</m.div>
	),
);
StaggerList.displayName = "StaggerList";

/** Child of StaggerList — picks up the parent's stagger schedule. */
export const FadeInItem = React.forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
	({ children, ...rest }, ref) => (
		<m.div ref={ref} variants={FADE_IN_VARIANTS} {...rest}>
			{children}
		</m.div>
	),
);
FadeInItem.displayName = "FadeInItem";

/**
 * For streaming lists where new items append at the bottom (event
 * stream). Each item fades+rises in on mount. AnimatePresence handles
 * removal if items are ever pruned. Reduce-motion users see only the
 * final mounted state.
 */
export function StreamItem({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<m.div
			variants={FADE_IN_VARIANTS}
			initial="hidden"
			animate="visible"
			className={className}
		>
			{children}
		</m.div>
	);
}

export { AnimatePresence, useReducedMotion };
