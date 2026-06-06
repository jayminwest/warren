import { describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import type { BridgeRegistry } from "../server/types.ts";
import { createMergePollerDispatch } from "./conversation-merge-dispatch.ts";
import { buildPlannerDispatchPrompt } from "./conversation-merge-poller.ts";
import type { SpawnRunInput, SpawnRunResult } from "./spawn/index.ts";

describe("createMergePollerDispatch", () => {
	test("spawns the planner keyed on plot_id off the project default branch", async () => {
		const captured: SpawnRunInput[] = [];
		const started: { runId: string; burrowRunId: string; burrowId: string }[] = [];

		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			captured.push(input);
			return {
				run: { id: "run_planner" } as SpawnRunResult["run"],
				burrow: { id: "bur_a", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_a" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const bridges: BridgeRegistry = {
			start(runId, burrowRunId, burrowId) {
				started.push({ runId, burrowRunId, burrowId });
			},
			async stopAll() {},
			size: () => 0,
		};

		const dispatch = createMergePollerDispatch({
			repos: {
				projects: { require: async () => ({ defaultBranch: "trunk" }) },
				// biome-ignore lint/suspicious/noExplicitAny: narrow test stub
			} as any,
			// biome-ignore lint/suspicious/noExplicitAny: unused by the spawn stub
			burrowClientPool: {} as any,
			bridges,
			// biome-ignore lint/suspicious/noExplicitAny: unused by the spawn stub
			warrenConfigs: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: unused by the spawn stub
			projectsConfig: {} as any,
			projectSpawn: (async () => ({})) as never,
			// biome-ignore lint/suspicious/noExplicitAny: unused by the spawn stub
			seedsCli: {} as any,
			spawnRunFn,
		});

		const result = await dispatch({
			conversationId: "conv_1",
			projectId: "proj_1",
			plotId: "plot-abc",
			plannerAgent: "planner",
		});

		expect(result).toEqual({ runId: "run_planner" });
		expect(captured).toHaveLength(1);
		const input = captured[0];
		expect(input?.agentName).toBe("planner");
		expect(input?.projectId).toBe("proj_1");
		expect(input?.plotId).toBe("plot-abc");
		expect(input?.ref).toBe("trunk");
		expect(input?.trigger).toBe("send-off");
		expect(input?.prompt).toBe(buildPlannerDispatchPrompt("plot-abc"));
		expect(input?.metadata).toEqual({ conversationId: "conv_1" });
		expect(started).toEqual([{ runId: "run_planner", burrowRunId: "rb_a", burrowId: "bur_a" }]);
	});
});
