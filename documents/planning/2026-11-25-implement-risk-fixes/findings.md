# Findings & Decisions

## Requirements

- Apply the risk fixes in the existing project audit report.
- Do not run or add tests unless requested; review changes and use static checks only.
- Update the existing analysis document and commit only task-related files locally.

## Research Findings

- Repository starts clean at `a53b878`, one local docs-only commit ahead of `origin/main`.
- Detailed findings and source locations are recorded in `documents/bugfixes/2026-11-25-project-logic-risk-review.md`.
- Release conventions use the package version and visible UI labels; implementation version is `2.6.2`.
- Existing inbox tasks persist `parentSessionId`; adding persisted `cwd` can expose the chosen execution target in the task card.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Bind live execution only to a root session already mapped to the task workspace; report unavailable otherwise. | Avoid wrong project cwd/model/preset inheritance. |
| Inject bounded context from the selected workspace only, without global profile or other workspace data. | Give tasks relevant knowledge while maintaining workspace boundaries. |
| Treat queued and running tasks as workspace locks. | Prevent stale tasks and orphaned results after state changes. |
| `mode: llm` is explicit opt-in; `mode: hybrid` only calls LLM when `llmJudge: true`. | Preserve an explicit LLM mode while making default hybrid local. |
| Route classification sends at most five candidate IDs/names plus the current user message, including the current workspace in the candidate set. | Remove descriptions, exemplars, memories, and prior turns from the provider payload. |
| Workspace locks include both persisted queued/running rows and active executor handles. | Cancellation can change or remove a task row before its child session has settled. |
| Two-hop routing must not remove turns from a locked source workspace. | Copy the provisional conversation into the new workspace while preserving the source under task lock. |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| Planning initializer template differed from the customization script's assumed headings. | Rewrote the initialized plan while preserving native phase/status markers. |

## Resources

- `lib/index.js`, `lib/executor.js`, `lib/store.js`, `lib/ui.js`, `scripts/build-shell-macos.sh`, `README.md`
- Existing audit: `documents/bugfixes/2026-11-25-project-logic-risk-review.md`
