import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * `React.lazy` for a named export (warren-b2d6). Pages export named
 * components, and `lazy` wants a default export — this adapts one to the
 * other without touching every page module.
 */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M & string>(
	load: () => Promise<M>,
	name: K,
): LazyExoticComponent<ComponentType> {
	return lazy(async () => {
		const mod = await load();
		return { default: mod[name] as ComponentType };
	});
}
