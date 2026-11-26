# Task Plan: Implement Project Risk Fixes

## Goal
Implement the agreed risk fixes across inbox execution, workspace mutation, LLM routing privacy, memory provenance, panel framing, and macOS shell build safety; document the result and commit locally.

## Next Step
Complete static checks, review the full diff and documentation, then commit the related files locally.

## Current Phase
Phase 3

## Phases

### Phase 1: Reconfirm scope

- [x] Inspect current source and relevant UI/API contracts
- [x] Record implementation decisions and limits
- [x] Check release/version and documentation conventions
- **Status:** complete

### Phase 2: Implement fixes

- [x] Bind inbox execution to the selected workspace and provide scoped context
- [x] Guard workspace mutations and capacity eviction when tasks are queued/running
- [x] Make LLM routing opt-in and minimize routing payload
- [x] Align assistant memory provenance with host turn identity
- [x] Add panel framing policy and safe shell build/signing behavior
- **Status:** complete

### Phase 3: Review and delivery

- [x] Independently review all source changes and documentation
- [x] Perform only non-test static checks permitted by scope
- [x] Update the existing analysis document and planning records
- [x] Commit only task-related files locally
- **Status:** complete

## Key Questions

1. How should inbox tasks select an execution target when no active session is bound to the workspace?
2. Which report findings can be fixed safely without changing unrelated behavior?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| No arbitrary parent-session fallback for inbox tasks. | Prevent task tools from inheriting another project’s cwd. |
| Block workspace destructive operations while queued/running tasks reference it. | Preserve task/workspace consistency with a shared invariant. |
| Keep the lock until the child run settles, even if cancellation clears its persisted task row. | Cancellation is asynchronous and may still be using the workspace. |
| Make hybrid route LLM opt-in and minimize prompt data. | Match the documented local-first behavior and reduce cross-workspace disclosure. |
| Use only the selected workspace's bounded context in inbox children; do not include global profile data. | Preserve workspace boundaries while supplying relevant project context. |

## Errors Encountered

| Error | Resolution |
|-------|------------|
| First planning-file customization script expected a different initializer template and stopped before writing the files. | Read the initialized files and customized the plan using their actual structure. |
| First UI version-label patch expected text absent from the file and did not apply. | Inspected the actual UI markup and applied the corrected patch. |
