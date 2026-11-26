# Task Plan: Restore UI and limit work to performance and security

## Goal
Restore the workspace UI to its pre-desktop-split behavior, then implement only justified performance improvements and security hardening.

## Next Step
Task complete; local commit created.

## Current Phase
Phase 5

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints
- [x] Document in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define approach
- [x] Create project structure
- **Status:** complete

### Phase 3: Implementation
- [x] Restore overlay and page UI behavior without reverting unrelated risk fixes
- [x] Bound JSONL storage and tail reads; handle asynchronous log-write failures
- [x] Restrict shell URL schemes and protect state/log files with private permissions
- [x] Update existing risk review with actual scope
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Run requested-safe static checks only; do not run tests unless requested
- [x] Independently review diffs for regressions and scope creep
- **Status:** complete

### Phase 5: Delivery
- [x] Commit the reviewed task locally
- [x] Deliver scope and validation limits
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Restore `lib/client.js` and desktop-only UI hooks to their pre-split behavior | User explicitly asked to restore UI changes; baseline is commit `0b33974` |
| Keep prior non-UI fixes and package version | They are unrelated risk fixes/current project version |
| Implement log bounds, snapshot payload reduction, poll overlap guard, URL scheme validation, and private data-file permissions | These are concrete performance/security items from the existing inventory |
| Skip state/schema reliability items, installer transaction work, test suite, and unrelated refactors | User limited this round to performance and security; AGENTS.md says do not run tests unless asked |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| A combined risk-report patch did not match the report section context | Applied smaller patches and replaced the section between exact headings |
| A route patch targeted `lib/index.js`, but the HTTP GET handler is in `lib/ui.js` | Located the actual handler and applied the summary option there |
| One file inspection call failed to start due to a workdir argument issue | Re-ran the inspection from the confirmed repository root |
| A plan update patch did not match the initialized status line | Re-read the initialized plan and applied changes against its exact markers |
| A follow-up plan patch had an incorrect progress-file context | Split the plan and progress updates into separate patches |
