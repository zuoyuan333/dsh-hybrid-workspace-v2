# Findings & Decisions

## Requirements
- Restore UI changes from the desktop/web split and title-bar adjustment.
- Preserve prior non-UI bug fixes.
- Only implement performance improvements and security risk fixes.
- Do not run tests unless requested; use static checks and independent code review.
- Keep plan files under `documents/planning/2026-11-26-restore-ui-perf-security/`.

## Research Findings
- Current HEAD is `c596cc6`; working tree was clean.
- UI changes are confined to `lib/client.js` and additions in `lib/ui.js` from `e12292a`; the baseline in `0b33974` uses the original title, 12px inset, browser link, and close button.
- The UI baseline's frontend title version may differ; keep the current `v2.6.3` title while restoring only layout/behavior.
- Default `snapshot()` and `/api` return complete archive records, including turns and memories; archive cards use only metadata, and restore/remove APIs operate against server state by ID. Preserve the default contract and let the panel opt into a summary response.
- The panel polls every 30 seconds; `get()` has no in-flight guard, so a slow request can overlap and stale responses can overwrite newer data.
- JSONL logs grow without bounds; `readJsonl()` reads the full file before slicing. Log writes are fire-and-forget, so async rejections escape the surrounding synchronous `try/catch`.
- `writeAtomic()` and `appendJsonl()` omit explicit private file modes. Existing data includes chat and memory content.
- Node.js documents that Windows `chmod()` cannot distinguish owner, group, and other permissions; `0700`/`0600` provide the intended confidentiality boundary on POSIX, while Windows continues to rely on user-profile ACLs.
- `isLoopbackShellUrl()` validates loopback host/path but not `http:`/`https:` scheme, while the macOS launcher accepts HTTP(S) arguments only.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Queue writes per JSONL path, cap individual records and rotate to a bounded tail | Preserve valid JSONL and prevent unbounded disk/read work; serialize trim operations against appends |
| Read only a bounded tail for recent logs | Limits memory and I/O even for legacy oversized files |
| Map archive state to the metadata consumed by the UI | Avoid transmitting archived conversation and memory text on every poll |
| Guard UI GET with an in-flight request and generation check | Prevent overlapping fetches and stale-response overwrite without changing UI layout |
| Create state/log/temp/backup files mode 0600 and the plugin-owned state directory mode 0700 | Limit local exposure of chat and memory contents |
| Require HTTP(S) in the shell URL validator | Match the native launcher and reject unsupported schemes early |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| The planning skill normally writes under `.planning/`, conflicting with repository instructions | Used a temporary `.planning` symlink to initialize directly under `documents/planning/`; removed the root symlink afterward |
| An initial patch assumed the GET route lived in `lib/index.js` | Located the route in `lib/ui.js` and applied the snapshot option at the correct boundary |
| One combined documentation patch did not match the report's exact section context | Split the edits into a smaller patch and a marker-based replacement |

## Resources
- Existing review: `documents/bugfixes/2026-11-25-project-logic-risk-review.md`
- Baseline UI: commit `0b33974`
