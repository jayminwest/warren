import { describe, expect, test } from "bun:test";
import type { ProjectRow } from "../../api/types.ts";
import {
	buildAdmissionRows,
	buildManifestLines,
	costCapLabel,
	isolationLabel,
	modelLabel,
	repositoryLabel,
	runBranchValue,
	timeLimitLabel,
} from "./manifest-view.ts";

const project = {
	id: "proj_1",
	gitUrl: "https://github.com/jayminwest/warren.git",
	defaultBranch: "main",
	hasSeeds: true,
} as unknown as ProjectRow;

describe("repositoryLabel", () => {
	test("reduces a GitHub URL to owner/repo", () => {
		expect(repositoryLabel("https://github.com/jayminwest/warren.git")).toBe("jayminwest/warren");
		expect(repositoryLabel("git@github.com:jayminwest/warren")).toBe("jayminwest/warren");
	});

	test("returns null for a URL it cannot parse", () => {
		expect(repositoryLabel("file:///tmp/repo")).toBeNull();
	});
});

describe("runBranchValue", () => {
	test("uses warren's built-in prefix when the project declares none", () => {
		expect(runBranchValue(undefined)).toBe("warren/<run id>");
	});

	test("uses the project's prefix when declared", () => {
		expect(runBranchValue("agents")).toBe("agents/<run id>");
	});
});

describe("summary labels", () => {
	test("isolationLabel names each runtime and nothing for an unknown one", () => {
		expect(isolationLabel("k8s")).toBe("Kubernetes pod");
		expect(isolationLabel("docker")).toBe("Docker container");
		expect(isolationLabel("local")).toBe("local sandbox");
		expect(isolationLabel(undefined)).toBeNull();
	});

	test("costCapLabel formats a valid cap and drops an empty or invalid one", () => {
		expect(costCapLabel("5")).toBe("$5.00");
		expect(costCapLabel("")).toBeNull();
		expect(costCapLabel("-1")).toBeNull();
	});

	test("timeLimitLabel formats whole minutes and drops an empty or invalid one", () => {
		expect(timeLimitLabel("60")).toBe("60 min");
		expect(timeLimitLabel("")).toBeNull();
		expect(timeLimitLabel("1.5")).toBeNull();
	});

	test("modelLabel joins provider and model, or returns null when both are empty", () => {
		expect(modelLabel("anthropic", "claude")).toBe("anthropic/claude");
		expect(modelLabel("", "claude")).toBe("claude");
		expect(modelLabel("", "")).toBeNull();
	});
});

describe("buildAdmissionRows", () => {
	test("lists isolation and the tracker, without checks the UI cannot verify", () => {
		const rows = buildAdmissionRows(project, { version: "1", runtime: "k8s", authMode: "token" });
		expect(rows.map((r) => r.label)).toEqual(["Isolated workspace", "Issue tracker"]);
		expect(rows.every((r) => r.status === "ok")).toBe(true);
	});

	test("marks a project without seeds as absent and adds the concurrency limit", () => {
		const rows = buildAdmissionRows({ ...project, hasSeeds: false } as ProjectRow, {
			version: "1",
			runtime: "local",
			authMode: "token",
			admission: { maxQueueDepth: 50, maxPendingPods: 20, maxProjectConcurrency: 3 },
		});
		expect(rows[1]?.status).toBe("absent");
		expect(rows[2]).toMatchObject({ label: "Concurrency limit", value: "3 per project" });
	});
});

describe("buildManifestLines", () => {
	test("falls back to the project's default branch and the warren branch prefix", () => {
		const lines = buildManifestLines({
			project,
			ref: " ",
			seedId: "",
			agent: "claude-code",
			provider: "",
			model: "",
			costCap: "",
			runBranchPrefix: undefined,
			runtime: "k8s",
		});
		expect(lines.find((l) => l.key === "ref: ")?.value).toBe("main");
		expect(lines.find((l) => l.key === "branch: ")?.value).toBe("warren/<run id>");
		expect(lines.find((l) => l.key === "durationMinutes: ")?.value).toBe("—");
	});
});
