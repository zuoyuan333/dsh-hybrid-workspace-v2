# Findings & Decisions

## Requirements

- Explain the project’s major logic and execution flow.
- Identify omissions and potential risks with code evidence and impact.
- Save analysis in `documents/bugfixes/`; do not modify application behavior during this audit.

## Research Findings

- Repository inventory is in progress.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Separate confirmed code-level issues from runtime risks that need verification. | Avoid presenting assumptions as observed failures. |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| The initializer writes plans under `.planning/`, conflicting with workspace policy. | Initialized in a temporary staging directory and copied the plan into `documents/planning/`. |

## Resources

- Repository root: `.`

### Initial repository map

- The repository is a Node.js ESM Cordis plugin, package version `2.6.1`, main entry `lib/index.js`, client entry `lib/client.js`, and one declared peer range: `@deepseek-ai/cordis >=4.0.2 <5.0.0` (`package.json`).
- Runtime is split across 17 `lib/*.js` modules, a profile patch manifest (`cordis.patch.yml`), an installer, an optional Swift macOS shell, and 26 test/support files under `test/`.
- README describes the key path as: incoming user message -> heuristic workspace routing / optional multi-topic segmentation -> context assembly and memory injection -> assistant response -> lifecycle extraction / workspace governance; UI supports manual correction, migration, import/export, inbox dispatch, shell chat.
- Documented hard boundaries include prompt-level context isolation, lexical heuristic limitations, single-process file state without cross-process locking, and localhost-only panel assumptions.
- Working tree was clean before the audit; no application code has been changed. At initial discovery, only the audit planning files had been created.

### Code-level risk candidates (to verify before finalizing)

- **LLM route privacy:** `lib/index.js` defaults `llmJudge: true`; in hybrid mode it calls the model on ambiguous routes. The route prompt includes up to 20 workspace names, descriptions, keywords, exemplars and recent decision memories, plus the current workspace’s last four turns and the incoming message (`classify`, around lines 462–510). This means the default is not wholly local/heuristic; provider data handling applies. README explains heuristic mistakes but does not clearly disclose this cross-workspace routing payload.
- **Inbox execution context mismatch:** `lib/executor.js` chooses a live session bound to the selected workspace if available, but otherwise falls back to any active bound/root session (lines 56–78), then copies that parent’s `cwd`, model, and preset into the child (lines 194–212). The child starts with `inheritedEventCount: 0` and receives only a generic plugin instruction plus workspace name/task (lines 216–260); `lib/index.js` skips subagent routing/context injection by default. A manually locked workspace therefore does not guarantee matching project context or working directory.
- **Workspace mutation during active inbox run:** the sweep and governance-apply paths explicitly skip workspaces with running tasks (`lib/index.js` around lines 318 and 1384), while manual archive/delete/merge and capacity eviction (`createWorkspace`) do not check `inboxRuns`. A running child can outlive its workspace or continue after its data has been merged/deleted; the task result can then remain attached to a missing/archived workspace.
- **Two-hop memory provenance mismatch (conditional):** the first user message’s provisional memory records `origin.turn` using the host turn number; assistant memories record `origin.turn` using the workspace round (`lib/index.js` around lines 688 and 858–860). Confirmation selects memories by equality against `pending.originTurn` (around lines 619–628). If host turn and workspace round differ, the provisional assistant memory can stay in the old workspace even while its turn text moves.
- **Validation boundary:** repository tests are extensive, but the integration harness is local/fake-context based (`test/fake-ctx.mjs`, `test/inbox-executor.test.mjs`); it does not prove behavior against a live DSH host, actual approval/runtime services, installed profile, browser, or native shell.

These are source observations, not runtime reproductions. Final severity and wording will be checked against tests and documentation before the report is written.

### Cross-checks and prioritization

- `docs/RESEARCH-v2.md` already documents the single-process/no-lock limitation and says real DSH `ask-llm` frequency/accuracy is unverified. It also documents the inbox executor's internal-service compatibility boundary. These should be reported as known boundaries, not newly discovered bugs.
- The `hybrid` route only invokes the LLM when lexical routing returns `ask-llm`; the `llmJudge` default is still `true`. The data-scope omission remains actionable because the README describes routing as local heuristics without explaining this fallback payload.
- The two-hop memory issue is conditional on host turn numbering differing from workspace round numbering; report as a medium-confidence integrity edge case, not a guaranteed failure.
- `createWorkspace` can auto-archive the oldest workspace at `maxWorkspaces`, with no active-task check. Manual `archive`, `delete`, and `merge` likewise have no active-task guard. Only automatic sweep and `governanceApply` guard running inbox tasks.
- `build-shell-macos.sh` recursively removes its destination before building and suppresses all `codesign` errors. The default path is a dedicated app bundle, but a caller-supplied path can be destructive and a failed signing step is invisible.
- Static review found no `Content-Security-Policy: frame-ancestors` or `X-Frame-Options` on the panel response. Because the page is intentionally embeddable inside DSH and browser local-network policy varies, this is a conditional clickjacking hardening concern, not a reproduced exploit.

## Scope and validation

- Read-only source/document/test inspection only. No application code was changed and no test suite or live DSH/device/browser execution was run.
- Findings are prioritized by demonstrated code path and impact; behavior dependent on host APIs or browser policy is explicitly marked unverified.
