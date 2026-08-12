# Live verification evidence

**Date:** 2026-08-12  
**Branch:** `test/cursor-live-validation`  
**Commit under test:** `29c6d6d`  
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
- Before the conclusive rerun, `bun run build` succeeded and refreshed the branch-local `dist/index.js`.

## Run record

| Run | Intended case | Result | Elapsed | Evidence status |
|---|---|---|---:|---|
| 1 | Normal short completion | Clean text response; proxy terminal diagnostic | 4.755 s | live pass |
| 2 | Long-reasoning turn | Clean response, `end_stream` status `clean`, bridge exit code 0 | 6.896 s | live pass |
| 3 | Tool-pause/resume turn | Tool pause and subsequent resume both completed; one tool observed | 5.117 s + 5.117 s | live pass |
| 4 | Idle/deliberately stalled turn | Non-destructive idle prompt completed; no forced stall was induced | 10.214 s | live pass with limitation |

The four authenticated cases completed through the branch-local proxy. Deterministic fixture and smoke evidence remain separate and are not promoted to live evidence.

## Conclusive normal-completion rerun

The minimum normal case was rerun after rebuilding the branch-local plugin. The wall-clock elapsed time was **6.537 s**; the proxy lifecycle elapsed time to terminal cleanup was **2.373 s**. The sanitized diagnostics recorded:

```text
outbound_model modelId=cursor-grok-4.6-high
message_dispatch messageCase=interactionUpdate interactionCase=heartbeat
turn_ended transportState=writable writable=true elapsedMs=2372
terminal elapsedMs=2373
```

The raw OpenCode response completed successfully. Raw output and diagnostics remain outside the repository.

## A1 and A7 verdicts

- **A1, Cursor-facing wire id:** **confirmed as `cursor-grok-4.6-high` for the tested high variant.** OpenCode's qualified model name is also `cursor/cursor-grok-4.6-high`; the proxy's `outbound_model.modelId` matched the provider-qualified id without the slash. This is a high-variant wire id, not the bare `grok-4.6` catalog id.
- **A7, `turnEnded` is normal completion and H2 remains open:** **confirmed for the tested normal completion.** The sanitized `turn_ended` event occurred at 2.372 s with `transportState=writable` and `writable=true` before cleanup, proving the H2 transport remained writable when `turnEnded` arrived. The terminal event followed at 2.373 s.

Existing deterministic evidence and prior-art research support the implementation direction, but neither answers these live-verification questions.

## Sanitization check

The captured artifacts were inspected only for structure and marker presence. Sanitized lifecycle records contain allowlisted stage names, elapsed times, byte lengths, status, exit code, and coarse message-case names. They contained no authorization headers, cookies, bearer tokens, or prompt text. Raw run output remains outside the repository and was not committed.

## Reproduction requirement

Residual limitations: the CLI requires a qualified variant model id, and this conclusive run tested the high variant rather than the bare catalog id. The idle case intentionally did not induce a provider stall. The A1/A7 conclusions are direct observations of one authenticated normal completion; broader variant and failure-path coverage remains outside this rerun. No product change is justified by these observations.

## Final stacked regression gates

**Date:** 2026-08-12
**Commit under test:** `89668b75e413fe268f8914ca3b799be7cc89e3c2`
**Evidence class:** final local regression gate on the fully stacked branch

All commands were run unpiped with their exit status captured directly:

| Gate | Exact command | Exit | Result |
|---|---|---:|---|
| Typecheck | `npx tsc -p tsconfig.json --noEmit` | 0 | PASS; no TypeScript errors |
| Full smoke | `bun test/smoke.ts` | 0 | PASS; `✓ All smoke tests passed` |
| Build | `bun run build` | 0 | PASS; `tsc -p tsconfig.json && node scripts/copy-runtime.mjs` |

Static/runtime count evidence: `test/smoke.ts` contains **185 assertion call sites**, **17 test functions**, and runtime reports **28 selectable fake Cursor scenarios**. All inherited stability cases and Grok 4.6 catalog/routing cases passed. No quarantines or known-failure markers appeared in the current smoke source/output.

The smoke suite writes conversation cache data under `~/.cache/opencode-cursor`; this cache location is expected and was not committed.

## Package script inspection and no-regression finding

`package.json` was inspected directly. Scripts present are `build`, `test`, and `prepublishOnly`. There is **no `lint` script** and **no root `typecheck` script**; the explicit TypeScript command above is the repository's typecheck entry point. No lint command was silently skipped.

Existing model behavior remains unchanged alongside Grok 4.6. Smoke confirms `grok-code-fast-1` retains its prior 128K context and non-reasoning metadata, while Grok 4.6 exposes 256K context, reasoning enabled, and 64K output metadata with explicit $2/$0.50 cached/$6 pricing. Both streaming and non-streaming Grok 4.6 routing assertions pass. **No regression found in existing model metadata or cost behavior.**
