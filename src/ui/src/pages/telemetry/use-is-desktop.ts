import { useEffect, useState } from "react";

/**
 * md+ only? True once the viewport reaches the desktop breakpoint
 * (warren-756e: hoisted out of telemetry.tsx so the loop tab's
 * chart-bucketing arm can share the one listener).
 */
export function useIsDesktop(): boolean {
	const [isDesktop, setIsDesktop] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(min-width: 768px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const update = () => setIsDesktop(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);
	return isDesktop;
}
