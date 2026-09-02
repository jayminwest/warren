import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import {
	AGENT_CONTAINER_NAME,
	buildRunPod,
	resolveK8sPodConfig,
	SPOT_NODE_SELECTOR_KEY,
	SPOT_NODE_SELECTOR_VALUE,
	SPOT_TOLERATION,
} from "./pod-spec.ts";
import { resolveSpot, spotPlacement } from "./pod-spot.ts";

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_01tdf3a0wg5e",
		originUrl: "https://github.com/acme/widgets.git",
		branch: "warren/run_01tdf3a0wg5e",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: {},
		...overrides,
	};
}

describe("resolveSpot", () => {
	test("WARREN_K8S_SPOT unset / blank / non-truthy ⇒ false", () => {
		expect(resolveSpot({})).toBe(false);
		expect(resolveSpot({ WARREN_K8S_SPOT: "" })).toBe(false);
		expect(resolveSpot({ WARREN_K8S_SPOT: "   " })).toBe(false);
		expect(resolveSpot({ WARREN_K8S_SPOT: "0" })).toBe(false);
		expect(resolveSpot({ WARREN_K8S_SPOT: "false" })).toBe(false);
		// Deliberately narrow: a typo must not silently move run pods onto
		// preemptible capacity.
		expect(resolveSpot({ WARREN_K8S_SPOT: "yes" })).toBe(false);
		expect(resolveSpot({ WARREN_K8S_SPOT: "on" })).toBe(false);
	});

	test("WARREN_K8S_SPOT truthy `1`/`true` (any case, trimmed) ⇒ true", () => {
		for (const value of ["1", "true", "TRUE", "True", " true ", " 1 "]) {
			expect(resolveSpot({ WARREN_K8S_SPOT: value })).toBe(true);
		}
	});
});

describe("spotPlacement", () => {
	test("returns the Autopilot Spot nodeSelector + NoSchedule toleration fragment", () => {
		expect(spotPlacement()).toEqual({
			nodeSelector: { [SPOT_NODE_SELECTOR_KEY]: SPOT_NODE_SELECTOR_VALUE },
			tolerations: [
				{
					key: SPOT_NODE_SELECTOR_KEY,
					operator: "Equal",
					value: SPOT_NODE_SELECTOR_VALUE,
					effect: "NoSchedule",
				},
			],
		});
	});
});

describe("resolveK8sPodConfig + buildRunPod with WARREN_K8S_SPOT (warren-2e2e)", () => {
	test("knob unset ⇒ spot off; pod carries no nodeSelector and no tolerations (goldens unchanged)", () => {
		expect(resolveK8sPodConfig({}).spot).toBeUndefined();
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}));
		expect(pod.spec?.nodeSelector).toBeUndefined();
		expect(pod.spec?.tolerations).toBeUndefined();
	});

	test("knob set ⇒ config.spot true; run pod carries the Spot selector + toleration", () => {
		const spotConfig = resolveK8sPodConfig({ WARREN_K8S_SPOT: "true" });
		expect(spotConfig.spot).toBe(true);
		const pod = buildRunPod(baseSpec(), spotConfig);
		expect(pod.spec?.nodeSelector).toEqual({ [SPOT_NODE_SELECTOR_KEY]: SPOT_NODE_SELECTOR_VALUE });
		expect(pod.spec?.tolerations).toEqual([{ ...SPOT_TOLERATION }]);
		// Nothing else about the pod shape changes.
		expect(pod.spec?.restartPolicy).toBe("Never");
		expect(pod.spec?.containers?.[0]?.name).toBe(AGENT_CONTAINER_NAME);
	});

	test("non-truthy spellings never flip the pod onto Spot", () => {
		for (const value of ["0", "yes", "on", "bogus"]) {
			expect(resolveK8sPodConfig({ WARREN_K8S_SPOT: value }).spot).toBeUndefined();
			const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({ WARREN_K8S_SPOT: value }));
			expect(pod.spec?.nodeSelector).toBeUndefined();
			expect(pod.spec?.tolerations).toBeUndefined();
		}
	});
});
