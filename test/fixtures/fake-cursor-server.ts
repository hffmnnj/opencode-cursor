import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../../src/proto/agent_pb";

const CONNECT_END_STREAM_FLAG = 0b00000010;

export type CursorScenario =
  | "clean-end-stream"
  | "clean-end-stream-kept-open"
  | "error-end-stream"
  | "empty-end-stream"
  | "missing-end-stream"
  | "malformed-terminal"
  | "malformed-server-message"
  | "partial-frame"
  | "slow-semantic-progress"
  | "semantic-progress-stall"
  | "semantic-progress-trickle"
  | "heartbeat-trickle"
  | "heartbeat-trickle-kept-open"
  | "turn-ended-semantic-stall"
  | "turn-ended-transport-close"
  | "checkpoint-trickle"
  | "transport-close-without-terminal"
  | "frame-error"
  | "goaway"
  | "stream-aborted"
  | "client-abort"
  | "silent-transport"
  | "transport-death"
  | "tool-pause-resume"
  | "tool-pause-transport-death"
  | "tool-pause-clean-exit";

export const CURSOR_SCENARIOS: readonly CursorScenario[] = [
  "clean-end-stream",
  "clean-end-stream-kept-open",
  "error-end-stream",
  "empty-end-stream",
  "missing-end-stream",
  "malformed-terminal",
  "malformed-server-message",
  "partial-frame",
  "slow-semantic-progress",
  "semantic-progress-stall",
  "semantic-progress-trickle",
  "heartbeat-trickle",
  "heartbeat-trickle-kept-open",
  "turn-ended-semantic-stall",
  "turn-ended-transport-close",
  "checkpoint-trickle",
  "transport-close-without-terminal",
  "frame-error",
  "goaway",
  "stream-aborted",
  "client-abort",
  "silent-transport",
  "transport-death",
  "tool-pause-resume",
  "tool-pause-transport-death",
  "tool-pause-clean-exit",
] as const;

export interface FakeCursorServer {
  apiUrl: string;
  setScenario: (scenario: CursorScenario) => void;
  assertClean: () => void;
  close: () => Promise<void>;
  /** Model ids observed on every Run request, in arrival order. */
  getRunRequestModelIds: () => string[];
  /** Test-only resource accounting hooks for proving cleanup assertions fire. */
  trackChild: (pid: number) => void;
  untrackChild: (pid: number) => void;
  trackBridgeEntry: (key: string) => void;
  untrackBridgeEntry: (key: string) => void;
}

/** Connect envelope: flags, four-byte big-endian payload size, then payload. */
export function frameConnectMessage(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

export function frameConnectEndStream(payload: Uint8Array): Buffer {
  return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

/** Deliberately violates the advertised Connect payload length. */
export function frameMalformedConnectMessage(payload: Uint8Array, advertisedLength: number): Buffer {
  const frame = frameConnectMessage(payload);
  frame.writeUInt32BE(advertisedLength, 1);
  return frame;
}

function serverMessage(message: Parameters<typeof create>[1]): Buffer {
  return toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message as never));
}

function textDelta(text: string): Buffer {
  return serverMessage({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(TextDeltaUpdateSchema, { text }),
        },
      }),
    },
  });
}

function heartbeat(): Buffer {
  return serverMessage({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
      }),
    },
  });
}

function turnEnded(): Buffer {
  return serverMessage({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  });
}

function checkpoint(): Buffer {
  return serverMessage({
    message: {
      case: "conversationCheckpointUpdate",
      value: create(ConversationStateStructureSchema, {}),
    },
  });
}

function toolPause(toolCallId: string): Buffer {
  return serverMessage({
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 1,
        execId: `fixture-exec-${toolCallId}`,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: "fixture-tool",
            toolName: "fixture-tool",
            toolCallId,
            providerIdentifier: "fixture",
            args: { input: new TextEncoder().encode("{}") },
          }),
        },
      }),
    },
  });
}

function isScenario(value: string): value is CursorScenario {
  return (CURSOR_SCENARIOS as readonly string[]).includes(value);
}

/**
 * Extract the model id from every Run request frame in a Connect-framed
 * client payload. The proxy sends each Run request as a framed
 * AgentClientMessage; heartbeats and other client messages are skipped.
 */
function decodeRunRequestModelIds(bytes: Buffer): string[] {
  const ids: string[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset]!;
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      bytes.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > bytes.length) break;
    if ((flags & 0b0000_0010) === 0) {
      const payload = bytes.subarray(offset + 5, frameEnd);
      if (payload.length > 0) {
        try {
          const decoded = fromBinary(AgentClientMessageSchema, payload);
          if (decoded.message.case === "runRequest") {
            const modelId =
              decoded.message.value.requestedModel?.modelId ??
              decoded.message.value.modelDetails?.modelId;
            if (modelId) ids.push(modelId);
          }
        } catch {}
      }
    }
    offset = frameEnd;
  }
  return ids;
}

/**
 * A local Connect-over-H2 server with bounded failure sequences. The request header
 * x-fake-cursor-scenario selects a scenario; setScenario supplies the default.
 */
export async function createFakeCursorServer(options: { deadlineMs?: number } = {}): Promise<FakeCursorServer> {
  const deadlineMs = options.deadlineMs ?? 100;
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  const streams = new Set<http2.ServerHttp2Stream>();
  const childPids = new Set<number>();
  const bridgeEntries = new Set<string>();
  const runRequestModelIds: string[] = [];
  let defaultScenario: CursorScenario = "clean-end-stream";
  let toolPauseCount = 0;

  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.once("close", () => sessions.delete(session));
  });

  server.on("stream", (stream, headers) => {
    streams.add(stream);
    stream.on("error", () => {});
    stream.once("close", () => streams.delete(stream));
    stream.resume();
    if (headers[":path"] !== "/agent.v1.AgentService/Run") {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }

    // Record which model id the proxy routed to Cursor on every Run request.
    const requestChunks: Buffer[] = [];
    stream.on("data", (chunk) => requestChunks.push(Buffer.from(chunk)));
    stream.once("close", () => {
      if (requestChunks.length > 0) {
        runRequestModelIds.push(
          ...decodeRunRequestModelIds(Buffer.concat(requestChunks)),
        );
      }
    });

    const requested = String(headers["x-fake-cursor-scenario"] ?? defaultScenario);
    const scenario = isScenario(requested) ? requested : defaultScenario;
    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed && !stream.closed && !stream.destroyed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }, deadlineMs);
    const finish = () => {
      completed = true;
      clearTimeout(timeout);
    };
    stream.once("close", finish);
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });

    if (scenario === "tool-pause-resume" || scenario === "tool-pause-transport-death" || scenario === "tool-pause-clean-exit") {
      const toolCallId = `fixture-call-${++toolPauseCount}`;
      let receivedInitialRequest = false;
      let paused = false;
      stream.on("data", (chunk) => {
        if (!receivedInitialRequest) {
          receivedInitialRequest = true;
          paused = true;
          stream.write(frameConnectMessage(toolPause(toolCallId)));
          if (scenario === "tool-pause-transport-death") {
            const session = stream.session;
            setTimeout(() => session.destroy(), 10);
          } else if (scenario === "tool-pause-clean-exit") {
            setTimeout(() => stream.end(frameConnectEndStream(new TextEncoder().encode("{}"))), 10);
          }
          return;
        }
        if (!paused || stream.closed || stream.destroyed) return;
        paused = false;
        const receivedExpectedResult = Buffer.from(chunk).includes(
          Buffer.from(`result-for-${toolCallId}`),
        );
        stream.end(Buffer.concat([
          frameConnectMessage(textDelta(receivedExpectedResult ? "resumed-correctly" : "resumed-with-wrong-result")),
          frameConnectEndStream(new TextEncoder().encode("{}")),
        ]));
      });
      return;
    }

    const endWith = (body: Uint8Array) => stream.end(frameConnectEndStream(body));
    const trickle = (payload: Buffer) => {
      let sent = 0;
      const interval = setInterval(() => {
        if (stream.closed || stream.destroyed || ++sent > 3) {
          clearInterval(interval);
          if (!stream.closed && !stream.destroyed) stream.end();
          return;
        }
        stream.write(frameConnectMessage(payload));
      }, 10);
    };
    const trickleUntilClosed = (payload: Buffer) => {
      const interval = setInterval(() => {
        if (stream.closed || stream.destroyed) return clearInterval(interval);
        stream.write(frameConnectMessage(payload));
      }, 10);
    };

    switch (scenario) {
      case "clean-end-stream":
        stream.end(Buffer.concat([frameConnectMessage(textDelta("complete")), frameConnectEndStream(new TextEncoder().encode("{}"))]));
        break;
      case "clean-end-stream-kept-open":
        stream.write(frameConnectEndStream(new TextEncoder().encode("{}")));
        break;
      case "error-end-stream":
        endWith(new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable", message: "fixture failure" } })));
        break;
      case "empty-end-stream":
        endWith(new Uint8Array());
        break;
      case "missing-end-stream":
        stream.end(frameConnectMessage(textDelta("truncated")));
        break;
      case "malformed-terminal":
        stream.end(frameMalformedConnectMessage(new TextEncoder().encode("{"), 9));
        break;
      case "malformed-server-message":
        stream.end(Buffer.concat([
          frameConnectMessage(new Uint8Array([0xff])),
          frameConnectEndStream(new TextEncoder().encode("{}")),
        ]));
        break;
      case "partial-frame":
        stream.end(frameConnectMessage(textDelta("partial")).subarray(0, 7));
        break;
      case "slow-semantic-progress": {
        let part = 0;
        const interval = setInterval(() => {
          if (stream.closed || stream.destroyed) return clearInterval(interval);
          if (part < 3) stream.write(frameConnectMessage(textDelta(`part-${++part}`)));
          else {
            clearInterval(interval);
            endWith(new TextEncoder().encode("{}"));
          }
        }, 15);
        break;
      }
      case "semantic-progress-stall":
        setTimeout(() => {
          if (!stream.closed && !stream.destroyed) {
            stream.write(frameConnectMessage(textDelta("before-semantic-stall")));
          }
        }, 10);
        break;
      case "semantic-progress-trickle": {
        let part = 0;
        const interval = setInterval(() => {
          if (stream.closed || stream.destroyed) return clearInterval(interval);
          if (part < 4) stream.write(frameConnectMessage(textDelta(`trickle-${++part}`)));
          else {
            clearInterval(interval);
            endWith(new TextEncoder().encode("{}"));
          }
        }, 20);
        break;
      }
      case "heartbeat-trickle":
        trickle(heartbeat());
        break;
      case "heartbeat-trickle-kept-open":
        trickleUntilClosed(heartbeat());
        break;
      case "turn-ended-semantic-stall":
        // Reproduces Cursor's normal-looking completion shape: text and
        // turnEnded arrive, but the HTTP/2 response remains open with no
        // Connect end-stream. The proxy's current turnEnded no-op must leave
        // the semantic-progress watchdog as the only terminal owner.
        stream.write(Buffer.concat([
          frameConnectMessage(textDelta("before-turn-ended-stall")),
          frameConnectMessage(turnEnded()),
        ]));
        break;
      case "turn-ended-transport-close":
        // A close after Cursor's completion signal must not change the already
        // clean terminal outcome. Retain the session before the proxy releases
        // the bridge so this scenario can still deliver the late close.
        const session = stream.session;
        stream.write(Buffer.concat([
          frameConnectMessage(textDelta("before-turn-ended-close")),
          frameConnectMessage(turnEnded()),
        ]));
        setTimeout(() => session.destroy(), 10);
        break;
      case "checkpoint-trickle":
        trickle(checkpoint());
        break;
      case "transport-close-without-terminal":
        // No turnEnded or Connect end-stream: this is an abnormal transport
        // failure and must reach proxy.ts finishTerminal's explicit-error path.
        stream.write(frameConnectMessage(textDelta("before-terminal-less-close")));
        setTimeout(() => stream.session.destroy(), 10);
        break;
      case "frame-error":
        stream.write(frameConnectMessage(textDelta("before-reset")));
        setTimeout(() => stream.close(http2.constants.NGHTTP2_PROTOCOL_ERROR), 10);
        break;
      case "goaway":
        stream.write(frameConnectMessage(textDelta("before-goaway")));
        setTimeout(() => stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR), 10);
        break;
      case "stream-aborted":
        stream.write(frameConnectMessage(textDelta("before-abort")));
        setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), 10);
        break;
      case "client-abort":
        // Send one frame, then intentionally remain open. The smoke test owns
        // the consumer-side cancel and must cause this H2 stream to disappear.
        stream.write(frameConnectMessage(textDelta("abort-ready")));
        break;
      case "silent-transport":
        // Keep the H2 connection open without emitting frames. Tests lower the
        // client session bound while disabling the first PING to exercise its
        // explicit timeout path without waiting for production timings.
        break;
      case "transport-death":
        setTimeout(() => stream.session.destroy(), 10);
        break;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    setScenario(scenario) { defaultScenario = scenario; },
    getRunRequestModelIds() { return [...runRequestModelIds]; },
    trackChild(pid) { childPids.add(pid); },
    untrackChild(pid) { childPids.delete(pid); },
    trackBridgeEntry(key) { bridgeEntries.add(key); },
    untrackBridgeEntry(key) { bridgeEntries.delete(key); },
    assertClean() {
      const leaks = [
        sessions.size && `${sessions.size} H2 session(s)`,
        streams.size && `${streams.size} H2 stream(s)`,
        childPids.size && `${childPids.size} child process(es)`,
        bridgeEntries.size && `${bridgeEntries.size} bridge map entry(ies)`,
      ].filter(Boolean);
      if (leaks.length) throw new Error(`Fake Cursor fixture leaked ${leaks.join(", ")}`);
    },
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      this.assertClean();
    },
  };
}
