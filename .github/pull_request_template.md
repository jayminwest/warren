Closes #

<!-- Claim the issue (comment on it) before opening a PR. See CONTRIBUTING.md. -->

## Summary

<!-- Bullet-point overview of what this PR does -->

-

## Changes

<!-- Files or areas affected -->

-

## Test plan

- [ ] I claimed the linked issue before opening this PR
- [ ] `bun run check:all` passes locally
- [ ] Manual verification (if applicable)

<details>
<summary>UI definition of done (for a PR that touches <code>src/ui/</code>; delete it otherwise)</summary>

The "UI conventions" section of `AGENTS.md` names the check behind each item.

- [ ] Colors, fonts, and sizes come from `src/ui/src/tokens.css` or Tailwind scale utilities. No new arbitrary values such as `text-[10px]` (`bun run lint`)
- [ ] Controls use the `src/ui/src/components/ui/` primitives. No raw form elements, and `style={}` holds CSS variables only (`bun run lint`)
- [ ] Checked at phone (393px) and desktop (1440px), in the light and the dark theme
- [ ] Each new or changed data surface has an empty, a loading, and an error state, and each one renders on phone
- [ ] Captions and messages use operator language: no seed ids, component names, API paths, or placeholder text
- [ ] A new screen route has a `PageSpec` in `scripts/ui-visual/pages.ts`
- [ ] `bun run check:ui-visual --build` passes locally (the golden comparison runs in CI only)
- [ ] UI bug fix: the red repro commit and the green fix commit are linked below, with the failing assertion
- [ ] No change under `scripts/ui-visual/__golden__/`, or the new baselines came from the `update_goldens` workflow and a human applied `ui-baseline-approved`
- [ ] The `ui-visual` and `design-review` checks are green on the head commit

</details>

## Agent disclosure

- [ ] An AI coding agent wrote some or all of this change. Tool: <!-- e.g. Claude Code, Codex, Cursor -->
- [ ] A human has reviewed this diff and will answer review comments
