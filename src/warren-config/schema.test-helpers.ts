export const VALID_TRIGGER = {
	id: "nightly-refactor",
	kind: "cron",
	cron: "0 3 * * *",
	timezone: "UTC",
	seed: "seeds-abc1",
	role: "refactor-bot",
};

export const VALID_SERVER_PREVIEW = {
	type: "server",
	command: "bun run dev",
	port: 3000,
	readiness_path: "/healthz",
	idle_ttl: "30m",
	max_lifetime: "8h",
};
