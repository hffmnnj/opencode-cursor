# Live verification evidence

**Date:** 2026-08-12  
**Branch:** `test/cursor-live-validation`  
**Commit under test:** `73681d7`  
**Evidence class:** live validation with authenticated read-only state; lifecycle evidence is sanitized and limited to the proxy allowlist

## Isolation and safety

- Dedicated tmux session: `cursor-live-validation`.
- Session was created detached and was never attached to, renamed, killed, or reused from another session.
- Isolated process environment used `CURSOR_PROXY_DIAGNOSTICS=1` and separate non-secret paths under `/var/tmp/james/opencode/cursor-live-validation/{config,cache,state}`.
- The OpenCode CLI reported its data and log roots as global paths rather than honoring a separate data-home override. No global credential file was copied, edited, or exposed.
- **Historical blocked attempt:** the first run from `73681d7` had no usable isolated credential store and returned sanitized `UnknownError` events. No login or secret handling was attempted.
- **Authenticated resume:** with explicit authorization, the separate process referenced the existing credential state read-only. Its database, config, cache, and state paths remained under `/var/tmp/james/opencode/cursor-live-validation/`; no credential file was copied or edited.
- The process loaded the branch-local plugin at `file:///home/james/Documents/opencode-cursor-fork/dist/index.js`, rather than a globally installed plugin.
- CLI discovery proved that the requested bare string `cursor-grok-4.6` is not a valid model id in this OpenCode version. Cursor exposes qualified variants such as `cursor/cursor-grok-4.6-high`; the authenticated runs used that discovered id and `--variant high`.

## Run record

| Run | Intended case | Result | Elapsed | Evidence status |
|---|---|---|---:|---|
| 1 | Normal short completion | Clean text response; proxy terminal diagnostic | 4.755 s | live pass |
| 2 | Long-reasoning turn | Clean response, `end_stream` status `clean`, bridge exit code 0 | 6.896 s | live pass |
| 3 | Tool-pause/resume turn | Tool pause and subsequent resume both completed; one tool observed | 5.117 s + 5.117 s | live pass |
| 4 | Idle/deliberately stalled turn | Non-destructive idle prompt completed; no forced stall was induced | 10.214 s | live pass with limitation |

The four authenticated cases completed through the branch-local proxy. Deterministic fixture and smoke evidence remain separate and are not promoted to live evidence.

## A1 and A7 verdicts

- **A1, Cursor-facing id is `grok-4.6`: partially resolved.** The exact requested bare string is not accepted by this CLI. Authenticated discovery exposes `cursor/cursor-grok-4.6-high` and related variants, and that model routed successfully through the local plugin. The sanitized lifecycle allowlist does not include the outbound model id, so the wire-level id cannot be proven from committed diagnostics. No differing wire id was observed, but this is not a claim that the wire id was directly captured.
- **A7, `turnEnded` is normal completion and H2 remains open: unresolved live.** All authenticated runs completed cleanly, and the long-reasoning case recorded a clean Connect `end_stream`. The allowlisted diagnostics recorded only `heartbeat` for message dispatch and did not expose a `turnEnded` event or an explicit “H2 open after turnEnded” observation. The result supports liveness but does not establish A7's precise event ordering.

Existing deterministic evidence and prior-art research support the implementation direction, but neither answers these live-verification questions.

## Sanitization check

The captured artifacts were inspected only for structure and marker presence. Sanitized lifecycle records contain allowlisted stage names, elapsed times, byte lengths, status, exit code, and coarse message-case names. They contained no authorization headers, cookies, bearer tokens, or prompt text. Raw run output remains outside the repository and was not committed.

## Reproduction requirement

Residual limitations: the CLI requires a qualified variant model id; the exact bare `cursor-grok-4.6` string is not selectable in OpenCode 1.15.3. The idle case intentionally did not induce a provider stall. A7 needs a future diagnostic allowlist or provider-side trace that records `turnEnded` and post-event H2 state without exposing content or credentials. No product change is justified by these observations alone.
