# Direction C operator console — design spec export

This tree is the in-repo export of the Paper canvas
"Warren · Direction C — Operator Console" (43 artboards), the approved
design for the src/ui rebuild tracked by plan pl-7e38. Agents working
the plan's page issues build from these files — the canvas itself is
not reachable from a dispatched run.

## Design premise

An agent run is a workload. The interface behaves like an
infrastructure console: quiet when the system is healthy, precise when
it is not, dense enough for diagnosis without turning every screen into
a dashboard. One fixed shell carries instance health. Tables carry
inventories. Event rows carry evidence. Green marks operability and
action, not decoration. No summary cards on inventories — the table is
the product. Run detail reads like a workload inspector; dispatch reads
like a deployment manifest.

## Files

- `tokens.css` — the complete oklch token set, dark + light, exported
  verbatim from the canvas. The single theming source. Components use
  only the base (dark) custom-property names; the light theme reassigns
  them from the `--color-lt-*` values.
- `screens/*.jsx` — per-screen JSX exports of the dark desktop
  artboards (1440px), inline styles, token variables preserved as
  `var(--color-*)`. These are structural references, not components to
  paste: translate them into repo conventions (kebab-case files,
   500-line budget, shared shell/components, wire types from
  `src/core/wire.ts`).
- `screens/mobile/*.jsx` — the seven 375px mobile artboards, for the
  responsive pass (warren-dea8). One shared degradation pattern:
  collapsed nav, stacked rails, table rows become row cards.

Light artboards exist in the canvas for every desktop screen; they are
token-swaps of the dark ones (the `lt-` mapping in `tokens.css`), so
only the dark JSX is exported. Placeholder data in the exports
(run ids, counts, costs) is illustrative — bind real API data.

## IA (from the canvas index artboard)

Sidebar sections and order — WORKLOADS: 01 Operations, 02 Runs,
03 Plan runs. INFRASTRUCTURE: 04 Projects, 05 Agents, 06 Telemetry.
Footer: 07 Instance, Documentation link, identity row. A topbar status
strip carries: control-plane health dot, RUNNING count, QUEUE count,
BURN $/h, RUNTIME kind, identity. Operations is the index route.

| Route id | Screen | Export | Role |
| --- | --- | --- | --- |
| c-operations | Operations | `screens/operations.jsx` | Instance overview: capacity, services, operator interventions, active workloads, recent control-plane events. Index route. |
| c-runs | Runs | `screens/runs.jsx` | Workload inventory. Filterable run index; no summary cards. |
| c-run | Run detail | `screens/run-detail.jsx` | Workload inspector: lifecycle phases, structured event tail, runtime facts, budget, prompt, steering, preview panel. |
| c-dispatch | Dispatch | `screens/dispatch.jsx` | Workload definition: intent on the left, resolved manifest + admission policy on the right. |
| c-dispatch-plan | Dispatch plan | `screens/dispatch-plan.jsx` | Walk definition: source plan, child order, per-child guardrails, merge gate. |
| c-plan-runs | Plan runs | `screens/plan-runs.jsx` | Walk inventory with child progress. |
| c-plan-run | Plan run detail | `screens/plan-run-detail.jsx` | Walk inspector: child-by-child gate state, source plan, delivered PRs. |
| c-projects | Projects | `screens/projects.jsx` | Repository registry: clone freshness, queue presence. |
| c-project | Project detail | `screens/project-detail.jsx` | Project inspector: dispatch defaults from .warren/config.yaml, cron triggers, ready plans. |
| c-agents | Agents | `screens/agents.jsx` | Agent registry: the seven boot-seeded builtins, read-only provenance. |
| c-telemetry | Telemetry | `screens/telemetry-loop.jsx`, `screens/telemetry-behavior.jsx`, `screens/telemetry-judge.jsx`, `screens/telemetry-economics.jsx` | Four tabs over run records, forge PR state, and judge verdicts. Judge tab degrades gracefully when the extension is absent. |
| c-events | Event explorer | `screens/event-explorer.jsx` | Every structured event in sequence order: filter, follow, export. |
| c-instance | Instance | `screens/instance.jsx` | Boot-resolved configuration, read-only. Auth mode and admission policy. (Canvas artboard is titled "Settings"; the page is Instance.) |
| c-login | Login | `screens/login.jsx` | Token gate: token verified against /whoami, spectator entry when the instance allows it. |

Mobile exports: `screens/mobile/operations.jsx`, `runs.jsx`,
`run-detail.jsx`, `dispatch.jsx`, `telemetry.jsx`,
`event-explorer.jsx`, `instance.jsx`.

## Typography

Inter (UI text) and JetBrains Mono (identifiers, counts, statuses,
labels). Base UI size 12px/16px; page titles 20px/24px semibold with
-0.025em tracking; section labels 10px semibold with 0.08em tracking,
uppercase; mono metadata 10-11px. Load both families with real
fallback stacks.
