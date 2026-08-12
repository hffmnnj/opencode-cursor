# Live verification evidence

**Date:** 2026-08-12  
**Branch:** `test/cursor-live-validation`  
**Commit under test:** `585b7e1`  
**Evidence class:** live-validation attempt; inconclusive because isolated authentication was unavailable

## Isolation and safety

- Dedicated tmux session: `cursor-live-validation`.
- Session was created detached and was never attached to, renamed, killed, or reused from another session.
- Isolated process environment used `CURSOR_PROXY_DIAGNOSTICS=1` and separate non-secret paths under `/var/tmp/james/opencode/cursor-live-validation/{config,cache,state}`.
- The OpenCode CLI reported its data and log roots as global paths rather than honoring a separate data-home override. No global credential file was copied, edited, or exposed.
- The isolated provider listing showed no usable isolated credential store. A normal completion attempt returned sanitized `UnknownError` events before a model result.
- No login was attempted. A new login or secret would be required to continue, so live validation stopped safely.

## Run record

| Run | Intended case | Result | Elapsed | Evidence status |
|---|---|---|---:|---|
| 1 | Normal short completion | OpenCode emitted two sanitized `UnknownError` events; no completion | under 5 s | inconclusive, authentication/configuration blocked |
| 2 | Long-reasoning turn | Not started after safe stop | — | not observed |
| 3 | Tool-pause/resume turn | Not started after safe stop | — | not observed |
| 4 | Idle/deliberately stalled turn | Not started after safe stop | — | not observed |

The four cases therefore provide no fabricated provider behavior. Deterministic fixture and smoke evidence remain separate and are not promoted to live evidence.

## A1 and A7 verdicts

- **A1, Cursor-facing id is `grok-4.6`: unresolved live.** The isolated process did not reach model discovery or a Cursor response.
- **A7, normal completion emits `turnEnded` and leaves H2 open: unresolved live.** No real Cursor lifecycle event was observed.

Existing deterministic evidence and prior-art research support the implementation direction, but neither answers these live-verification questions.

## Sanitization check

The captured artifacts were inspected only for structure and marker presence. They contained no authorization headers, cookies, bearer tokens, or prompt text. Only error type/shape and byte counts were retained for this document; raw run output was not committed.

## Reproduction requirement

Repeat this task only after the operator provides an already-authenticated isolated OpenCode data/config arrangement, or explicitly authorizes a safe read-only reference to an existing credential store. Do not request, copy, print, or handle the secret in the validation task.
