# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## Install in OpenCode

Add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ]
}
```

The plugin registers the `cursor` provider and its models automatically once
you are logged in — no manual `provider` stub or model list is needed.

OpenCode installs npm plugins automatically at startup, so users do not need
to clone this repository.

## Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## Models

Grok 4.6 is supported on two surfaces that stay consistent:

- **Fallback catalog id `grok-4.6`** — the plugin's resilience path when live
  discovery is unavailable. It carries the Cursor-facing metadata: 256K default
  context, reasoning enabled (Cursor lists Grok 4.6 with Agent + Thinking), and
  64K max output.
- **Live-discovered variants** — `GetUsableModels` is authoritative and returns
  whatever Cursor serves, typically qualified variant ids. Live-verified:
  OpenCode's model name `cursor/cursor-grok-4.6-high` is sent to Cursor's Run
  API as the wire id `cursor-grok-4.6-high`. The bare `grok-4.6` id remains the
  fallback catalog entry.

Cursor-facing short-context pricing is **$2 input / $6 output per million
tokens**, with a **$0.50 cached-read** rate. The xAI direct API advertises a
500K window and accepts image input; neither applies to this plugin, which is
text-in / text-out for every model. Image and vision input are never forwarded,
so Grok 4.6 is text-only here.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — redirects Cursor's built-in filesystem/shell tools
   to the equivalent OpenCode tools, and exposes OpenCode's tool surface via
   Cursor MCP.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model calls a tool:
   - native tools (readArgs, shellArgs, grepArgs, ...) with an OpenCode
     equivalent are redirected to it (read, bash, grep, glob, webfetch, write)
   - native tools without an equivalent are rejected with a typed error
   - MCP tools arrive as mcpArgs exec messages
3. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
4. OpenCode executes tool, sends result in follow-up request
5. Proxy resumes H2 stream with the typed native result (or mcpResult),
   streams continuation
```

### Conversation state

Conversation history is rebuilt from the OpenAI messages on every request
(`rootPromptMessagesJson` + content-addressed turn blobs), and server
checkpoints are persisted to `~/.cache/opencode-cursor/conversations/` so
context survives restarts. Set `CURSOR_PROXY_DEBUG=1` to log the KV blob
handshake and exec traffic when debugging.

## Configuration and timeouts

All defaults work out of the box; **no configuration is required.** Every
timeout below is read by the code path that enforces it and has a hard cap, so
an invalid environment value can never disable the guard.

### Diagnostics and logging

| Variable | Default | Behavior |
|---|---|---|
| `CURSOR_PROXY_DIAGNOSTICS` | off | `1` emits one-line JSON lifecycle records to stderr: `auth_access_start/complete`, `auth_refresh_start/complete/failed`, `proxy_entry`, `bridge_spawn`, `bridge_start`, `h2_connect`, `connect_stream`, `bridge_data`, `connect_frame`, `message_dispatch`, `outbound_model`, `tool_pause`, `tool_resume`, `sse_emission`, `end_stream`, `turn_ended`, and `terminal`. Fields are allowlisted — stage names, elapsed times, byte lengths, status/exit codes, error class names, the outbound Cursor wire `modelId`, and parent-observed transport state (`transportState`, `writable`). Tokens, authorization headers, cookies, prompt text, tool payloads, and blob/checkpoint IDs are never serialized. |
| `CURSOR_PROXY_DEBUG` | off | Verbose KV-blob, exec-redirect, and end-stream debug lines on stderr. |

### Timeouts

| Variable | Default | Cap | Bounds |
|---|---|---|---|
| `CURSOR_REFRESH_TIMEOUT_MS` | 15 000 (15s) | 60 000 (60s) | Token refresh fetch; a stall returns a sanitized `token_refresh_timeout` 504. |
| `CURSOR_PROXY_FIRST_PROGRESS_TIMEOUT_MS` | 900 000 (15 min) | 3 600 000 (60 min) | Wait for the first semantic progress (text, thinking, positive token delta, or exec transition). |
| `CURSOR_PROXY_SEMANTIC_PROGRESS_TIMEOUT_MS` | 600 000 (10 min) | 1 800 000 (30 min) | Max silence between semantic progress events. Heartbeat, checkpoint, and query traffic never defer it; slow-but-progressing streams are preserved. |
| `CURSOR_BRIDGE_PING_INTERVAL_MS` | 15 000 (15s) | 300 000 (5 min) | HTTP/2 PING cadence that validates the transport path. |
| `CURSOR_BRIDGE_PING_TIMEOUT_MS` | 10 000 (10s) | 60 000 (60s) | PING response window; a miss fails the session explicitly. |
| `CURSOR_BRIDGE_SESSION_TIMEOUT_MS` | 120 000 (2 min) | 600 000 (10 min) | HTTP/2 session inactivity bound; expiry fails the session explicitly. |
| `CURSOR_BRIDGE_FAILURE_EXIT_DELAY_MS` | 0 | 1 000 (1s) | **Internal test seam — not recommended for configuration.** Briefly retains a failed bridge child so tests can exercise parent-side handling of a process-alive, transport-dead resume. Leave unset. |

Fixed transport constants (not environment-tunable): the initial Connect bound
is 30s, the bridge activity/idle bound is 120s, the proxy writes a client
heartbeat every 5s, and unary discovery RPCs time out after 5s.

### Endpoint and path overrides

| Variable | Default | Notes |
|---|---|---|
| `CURSOR_API_URL` | `https://api2.cursor.sh` | Connect endpoint override, read once at module load. The smoke harness uses it to point at the fake Cursor backend. |
| `CURSOR_REFRESH_URL` | `https://api2.cursor.sh/auth/exchange_user_api_key` | Token refresh endpoint override, read once at module load. Test harness seam. |
| `XDG_CACHE_HOME` | `~/.cache` | Base for the `opencode-cursor/conversations` disk cache. |
| `XDG_DATA_HOME` | `~/.local/share` | Base for the `opencode/auth.json` credential lookup. |
| `OPENCODE_AUTH_CONTENT` | — | Replaces on-disk `auth.json` contents; testing seam. |

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription