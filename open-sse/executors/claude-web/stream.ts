import { randomUUID } from "crypto";

import {
  mergeCitationResults,
  normalizeCitationsFromResponse,
  type CitationNormalizationResult,
} from "../../translator/citationNormalizer.ts";
import { buildErrorBody } from "../../utils/error.ts";
import type { ExecutorLog } from "../base.ts";

export interface ClaudeWebStreamOptions {
  model: string;
  stream: boolean;
  responseMetadata: Record<string, string>;
  provenance?: Record<string, unknown>;
  onComplete(result: { assistantText: string; stopReason: string }): void;
  onFailure(): void;
  log?: ExecutorLog | null;
}

type StreamPhase = "awaiting_message" | "in_message" | "stopped" | "failed";
type BlockKind = "thinking" | "text" | "tool" | "other";
const MAX_CLAUDE_WEB_SSE_PENDING_CHARS = 1024 * 1024;
type SemanticEvent =
  | { kind: "content"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "citations"; result: CitationNormalizationResult }
  | { kind: "metadata"; eventType: string; data: Record<string, unknown> }
  | { kind: "finish"; stopReason: string };

const KNOWN_METADATA_EVENTS = new Set([
  "ping",
  "completion",
  "message_limit",
  "content_block_retract",
  "model_fallback",
  "model_update",
  "compaction_status",
  "conversation_ready",
  "cache_performance",
  "tool_approval",
]);

const METADATA_EVENT_FIELDS: Record<string, readonly string[]> = {
  ping: ["latency_ms"],
  completion: [],
  message_limit: ["remaining", "limit", "reset_at"],
  content_block_retract: ["index"],
  model_fallback: ["model", "fallback_model"],
  model_update: ["model"],
  compaction_status: ["status"],
  conversation_ready: ["status"],
  cache_performance: ["hit", "read_tokens", "write_tokens"],
  tool_approval: ["status"],
};

interface StreamControl {
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  cancelled: boolean;
}

class ClaudeWebProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeWebProtocolError";
  }
}

function safeProtocolLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.slice(0, 80).replace(/[^A-Za-z0-9._:-]/g, "_");
  return normalized || "unknown";
}

function protocolDiagnostic(error: unknown): string {
  const detail =
    error instanceof ClaudeWebProtocolError ? error.message : "Unexpected stream parser failure";
  return `Claude Web stream protocol validation failed: ${detail}`;
}

async function* decodeSseData(
  source: ReadableStream<Uint8Array>,
  control: StreamControl
): AsyncGenerator<string, void, void> {
  const reader = source.getReader();
  control.reader = reader;
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let dataChars = 0;
  let reachedEof = false;

  const consumeLine = (rawLine: string): string | null => {
    if (rawLine.length > MAX_CLAUDE_WEB_SSE_PENDING_CHARS) {
      throw new ClaudeWebProtocolError("SSE line exceeded the size limit");
    }
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (dataLines.length === 0) return null;
      const data = dataLines.join("\n");
      dataLines = [];
      dataChars = 0;
      return data;
    }
    if (line.startsWith(":")) return null;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex < 0 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataChars += value.length + (dataLines.length > 0 ? 1 : 0);
      if (dataChars > MAX_CLAUDE_WEB_SSE_PENDING_CHARS) {
        throw new ClaudeWebProtocolError("SSE event exceeded the size limit");
      }
      dataLines.push(value);
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const frame = consumeLine(line);
        if (frame !== null) yield frame;
        newlineIndex = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_CLAUDE_WEB_SSE_PENDING_CHARS) {
        throw new ClaudeWebProtocolError("SSE line exceeded the size limit");
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const frame = consumeLine(buffer);
      if (frame !== null) yield frame;
    }
    const finalFrame = consumeLine("");
    if (finalFrame !== null) yield finalFrame;
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => {});
    if (control.reader === reader) control.reader = null;
    try {
      reader.releaseLock();
    } catch {
      // The source may already have released its reader after an abort.
    }
  }
}

function safeMetadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:+/@-]+$/.test(value)) {
    return value;
  }
  return undefined;
}

function projectMetadataEvent(
  eventType: string,
  event: Record<string, unknown>
): Record<string, unknown> {
  const projected: Record<string, unknown> = { type: eventType };
  for (const field of METADATA_EVENT_FIELDS[eventType] ?? []) {
    const value = safeMetadataValue(event[field]);
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeWebProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBlockIndex(event: Record<string, unknown>): number {
  if (!Number.isInteger(event.index) || (event.index as number) < 0) {
    throw new ClaudeWebProtocolError("Content block index is invalid");
  }
  return event.index as number;
}

function deltaText(delta: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = delta[field];
    if (typeof value === "string") return value;
  }
  throw new ClaudeWebProtocolError("Content delta text is invalid");
}

function thinkingSummaryText(delta: Record<string, unknown>): string {
  if (typeof delta.summary === "string") return delta.summary;
  if (delta.summary && typeof delta.summary === "object" && !Array.isArray(delta.summary)) {
    return deltaText(delta.summary as Record<string, unknown>, ["summary", "text", "thinking"]);
  }
  return deltaText(delta, ["text", "thinking"]);
}

interface ProtocolState {
  phase: StreamPhase;
  openBlocks: Map<number, BlockKind>;
  seenBlocks: Map<number, BlockKind>;
  stopReason: string;
  recentEvents: string[];
}

function protocolFailure(state: ProtocolState, message: string): never {
  state.phase = "failed";
  const trace = state.recentEvents.length > 0 ? `; trace=${state.recentEvents.join(">")}` : "";
  throw new ClaudeWebProtocolError(`${message}${trace}`);
}

function recordProtocolEvent(
  state: ProtocolState,
  eventType: string,
  event: Record<string, unknown>
): void {
  let detail = safeProtocolLabel(eventType);
  if (eventType === "content_block_start") {
    const block =
      event.content_block && typeof event.content_block === "object"
        ? (event.content_block as Record<string, unknown>)
        : null;
    detail += `:${safeProtocolLabel(block?.type)}`;
  } else if (eventType === "content_block_delta") {
    const delta =
      event.delta && typeof event.delta === "object"
        ? (event.delta as Record<string, unknown>)
        : null;
    detail += `:${safeProtocolLabel(delta?.type)}`;
  } else if (eventType === "error") {
    const upstreamError =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : null;
    detail += `:${safeProtocolLabel(upstreamError?.type)}:${safeProtocolLabel(upstreamError?.code)}`;
  }
  state.recentEvents.push(detail);
  if (state.recentEvents.length > 12) state.recentEvents.shift();
}

function assertInMessage(
  state: ProtocolState,
  eventType: string,
  blocksMustBeClosed = false
): void {
  if (state.phase !== "in_message" || (blocksMustBeClosed && state.openBlocks.size > 0)) {
    protocolFailure(state, `${eventType} is out of order`);
  }
}

function parseProtocolEvent(
  data: string,
  state: ProtocolState
): { event: Record<string, unknown>; eventType: string } {
  let event: Record<string, unknown>;
  try {
    event = requireRecord(JSON.parse(data), "SSE event");
  } catch (error) {
    if (error instanceof ClaudeWebProtocolError) throw error;
    protocolFailure(state, "SSE event contains malformed JSON");
  }

  const eventType = event.type;
  if (typeof eventType !== "string" || !eventType) {
    protocolFailure(state, "SSE event type is missing");
  }
  return { event, eventType };
}

function handleMessageStart(state: ProtocolState): null {
  if (state.phase !== "awaiting_message") {
    protocolFailure(state, "message_start is out of order");
  }
  state.phase = "in_message";
  return null;
}

function blockKind(block: Record<string, unknown>): BlockKind {
  if (block.type === "thinking") return "thinking";
  if (block.type === "text") return "text";
  if (block.type === "tool_use" || block.type === "server_tool_use") return "tool";
  return "other";
}

function handleContentBlockStart(
  event: Record<string, unknown>,
  state: ProtocolState
): SemanticEvent | null {
  assertInMessage(state, "content_block_start");
  const index = requireBlockIndex(event);
  if (state.openBlocks.has(index)) protocolFailure(state, "Content block was opened twice");

  const kind = blockKind(requireRecord(event.content_block, "content_block"));
  state.openBlocks.set(index, kind);
  state.seenBlocks.set(index, kind);
  return kind === "thinking" ? { kind: "reasoning", text: "" } : null;
}

function handleContentBlockDelta(
  event: Record<string, unknown>,
  state: ProtocolState
): SemanticEvent | null {
  assertInMessage(state, "content_block_delta");
  const index = requireBlockIndex(event);
  const delta = requireRecord(event.delta, "delta");
  const block = state.openBlocks.get(index);
  if (!block) {
    // Claude Web can refine a thinking summary after that thinking block has
    // closed and a first-party tool block has started. Accept only this known
    // retrospective delta and only for an index previously opened as thinking.
    if (
      delta.type === "thinking_summary_delta" &&
      state.seenBlocks.get(index) === "thinking"
    ) {
      return { kind: "reasoning", text: thinkingSummaryText(delta) };
    }
    return protocolFailure(state, "Content delta has no open block");
  }
  if (delta.type === "text_delta" && block === "text") {
    return { kind: "content", text: deltaText(delta, ["text"]) };
  }
  if (delta.type === "thinking_delta" && block === "thinking") {
    return { kind: "reasoning", text: deltaText(delta, ["thinking", "text"]) };
  }
  if (delta.type === "thinking_summary_delta" && block === "thinking") {
    return { kind: "reasoning", text: thinkingSummaryText(delta) };
  }
  if (delta.type === "input_json_delta" && block === "tool") {
    if (typeof delta.partial_json !== "string") {
      return protocolFailure(state, "Tool input delta JSON is invalid");
    }
    // Claude Web executes its own first-party tools (for example web search)
    // inside the same completion. Keep validating the protocol, but do not leak
    // internal tool arguments into the OpenAI-compatible answer stream.
    return null;
  }
  if (delta.type === "tool_use_block_update_delta" && block === "tool") {
    // This is Claude Web's progress/update frame for a first-party tool. Its
    // payload is UI state, not answer content, so validate the recognized event
    // type and intentionally keep it off the OpenAI-compatible wire response.
    return null;
  }
  if (
    block === "text" &&
    (delta.type === "citation_start_delta" ||
      delta.type === "citation_delta" ||
      delta.type === "citation_end_delta")
  ) {
    // Claude Web emits citations as deltas inside the surrounding text block.
    // The raw event has already gone through the citation normalizer above;
    // this branch only keeps the strict block-order validator in sync.
    return null;
  }
  return protocolFailure(
    state,
    `Content delta type ${safeProtocolLabel(delta.type)} does not match block ${safeProtocolLabel(block)}`
  );
}

function handleContentBlockStop(event: Record<string, unknown>, state: ProtocolState): null {
  assertInMessage(state, "content_block_stop");
  if (!state.openBlocks.delete(requireBlockIndex(event))) {
    protocolFailure(state, "Content block stop has no open block");
  }
  return null;
}

function handleMessageDelta(event: Record<string, unknown>, state: ProtocolState): null {
  assertInMessage(state, "message_delta", true);
  const delta = requireRecord(event.delta, "message_delta.delta");
  const stopReason = delta.stop_reason;
  if (stopReason === null || stopReason === undefined) return null;
  if (typeof stopReason !== "string" || !stopReason) {
    protocolFailure(state, "Stop reason is invalid");
  }
  state.stopReason = stopReason;
  return null;
}

function handleMessageStop(state: ProtocolState): SemanticEvent {
  assertInMessage(state, "message_stop", true);
  state.phase = "stopped";
  return { kind: "finish", stopReason: state.stopReason };
}

function dispatchProtocolEvent(
  eventType: string,
  event: Record<string, unknown>,
  state: ProtocolState
): SemanticEvent | null {
  switch (eventType) {
    case "message_start":
      return handleMessageStart(state);
    case "content_block_start":
      return handleContentBlockStart(event, state);
    case "content_block_delta":
      return handleContentBlockDelta(event, state);
    case "content_block_stop":
      return handleContentBlockStop(event, state);
    case "message_delta":
      return handleMessageDelta(event, state);
    case "message_stop":
      return handleMessageStop(state);
    case "error":
      return protocolFailure(state, "Upstream reported a stream error");
    default:
      return protocolFailure(
        state,
        `Unknown Claude Web stream event (${safeProtocolLabel(eventType)})`
      );
  }
}

async function* parseClaudeWebEvents(
  source: ReadableStream<Uint8Array>,
  control: StreamControl
): AsyncGenerator<SemanticEvent, void, void> {
  const state: ProtocolState = {
    phase: "awaiting_message",
    openBlocks: new Map(),
    seenBlocks: new Map(),
    stopReason: "end_turn",
    recentEvents: [],
  };

  for await (const data of decodeSseData(source, control)) {
    if (data === "[DONE]") {
      protocolFailure(state, "DONE arrived before message_stop");
    }

    const { event, eventType } = parseProtocolEvent(data, state);
    recordProtocolEvent(state, eventType, event);
    const citationResult = normalizeCitationsFromResponse(event);
    if (citationResult.metadata.status !== "none") {
      yield { kind: "citations", result: citationResult };
    }
    if (KNOWN_METADATA_EVENTS.has(eventType)) {
      yield { kind: "metadata", eventType, data: projectMetadataEvent(eventType, event) };
      continue;
    }

    const semanticEvent = dispatchProtocolEvent(eventType, event, state);
    if (!semanticEvent) continue;
    yield semanticEvent;
    if (semanticEvent.kind === "finish") return;
  }

  if (control.cancelled) return;
  throw new ClaudeWebProtocolError("Claude Web stream ended before message_stop");
}

function openAiFinishReason(stopReason: string): string {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  return "stop";
}

function makeChunk(
  id: string,
  created: number,
  options: ClaudeWebStreamOptions,
  delta: Record<string, unknown>,
  finishReason: string | null,
  event?: { type: string; data: Record<string, unknown> },
  citationResult?: CitationNormalizationResult
): Record<string, unknown> {
  const omniroute = {
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(citationResult ? { citations: citationResult.metadata } : {}),
  };
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: options.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    claude_web: {
      ...options.responseMetadata,
      ...(event ? { event } : {}),
    },
    ...(Object.keys(omniroute).length > 0 ? { omniroute } : {}),
  };
}

function protocolErrorBody(): Record<string, unknown> {
  const body = buildErrorBody(502, "Claude Web stream protocol error");
  body.error.type = "upstream_protocol_error";
  body.error.code = "claude_web_protocol_error";
  return body as unknown as Record<string, unknown>;
}

function responseHeaders(contentType: string, metadata: Record<string, string>): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  const headerNames: Record<string, string> = {
    operation: "X-OmniRoute-Claude-Web-Operation",
    conversation_id: "X-OmniRoute-Claude-Web-Conversation-Id",
    parent_message_uuid: "X-OmniRoute-Claude-Web-Parent-Message-Uuid",
    assistant_message_uuid: "X-OmniRoute-Claude-Web-Assistant-Message-Uuid",
  };
  for (const [key, headerName] of Object.entries(headerNames)) {
    const value = metadata[key];
    if (value) headers.set(headerName, value.replace(/[\r\n]/g, ""));
  }
  return headers;
}

function notifyFailure(options: ClaudeWebStreamOptions): void {
  try {
    options.onFailure();
  } catch {
    options.log?.error?.("CLAUDE-WEB-STREAM", "Failure callback threw an error");
  }
}

function notifyComplete(
  options: ClaudeWebStreamOptions,
  result: { assistantText: string; stopReason: string }
): void {
  try {
    options.onComplete(result);
  } catch {
    options.log?.error?.("CLAUDE-WEB-STREAM", "Completion callback threw an error");
  }
}

async function createBufferedResponse(
  source: ReadableStream<Uint8Array>,
  options: ClaudeWebStreamOptions
): Promise<Response> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let assistantText = "";
  let reasoningText = "";
  let stopReason = "end_turn";
  const metadataEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const citationResults: CitationNormalizationResult[] = [];
  const control: StreamControl = { reader: null, cancelled: false };

  try {
    for await (const event of parseClaudeWebEvents(source, control)) {
      if (event.kind === "content") assistantText += event.text;
      if (event.kind === "reasoning") reasoningText += event.text;
      if (event.kind === "citations") citationResults.push(event.result);
      if (event.kind === "metadata") {
        metadataEvents.push({ type: event.eventType, data: event.data });
      }
      if (event.kind === "finish") stopReason = event.stopReason;
    }
    const citations = mergeCitationResults(...citationResults);
    notifyComplete(options, { assistantText, stopReason });
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: options.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: assistantText,
              annotations: citations.annotations,
              ...(reasoningText ? { reasoning_content: reasoningText } : {}),
            },
            finish_reason: openAiFinishReason(stopReason),
            logprobs: null,
          },
        ],
        claude_web: {
          ...options.responseMetadata,
          events: metadataEvents,
        },
        omniroute: {
          citations: citations.metadata,
          ...(options.provenance ? { provenance: options.provenance } : {}),
        },
      }),
      {
        status: 200,
        headers: responseHeaders("application/json", options.responseMetadata),
      }
    );
  } catch (error) {
    options.log?.error?.("CLAUDE-WEB-STREAM", protocolDiagnostic(error));
    notifyFailure(options);
    return new Response(JSON.stringify(protocolErrorBody()), {
      status: 502,
      headers: responseHeaders("application/json", options.responseMetadata),
    });
  }
}

interface StreamingState {
  encoder: TextEncoder;
  id: string;
  created: number;
  control: StreamControl;
  iterator: AsyncIterator<SemanticEvent, void, void>;
  pendingChunks: Uint8Array[];
  assistantText: string;
  citations: CitationNormalizationResult;
  outcome: "pending" | "completed" | "failed";
  terminal: boolean;
  closed: boolean;
}

function encodeStreamEvent(state: StreamingState, value: Record<string, unknown>): Uint8Array {
  return state.encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function failStreamOnce(state: StreamingState, options: ClaudeWebStreamOptions): void {
  if (state.outcome !== "pending") return;
  state.outcome = "failed";
  notifyFailure(options);
}

function closeStreamIfDrained(
  state: StreamingState,
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  if (!state.closed && state.terminal && state.pendingChunks.length === 0) {
    state.closed = true;
    controller.close();
  }
}

function flushStreamChunk(
  state: StreamingState,
  controller: ReadableStreamDefaultController<Uint8Array>
): boolean {
  const chunk = state.pendingChunks.shift();
  if (!chunk) {
    closeStreamIfDrained(state, controller);
    return false;
  }
  controller.enqueue(chunk);
  closeStreamIfDrained(state, controller);
  return true;
}

async function queueSemanticEvent(
  state: StreamingState,
  event: SemanticEvent,
  options: ClaudeWebStreamOptions
): Promise<void> {
  if (event.kind === "content") {
    state.assistantText += event.text;
    state.pendingChunks.push(
      encodeStreamEvent(
        state,
        makeChunk(state.id, state.created, options, { content: event.text }, null)
      )
    );
    return;
  }
  if (event.kind === "reasoning") {
    state.pendingChunks.push(
      encodeStreamEvent(
        state,
        makeChunk(state.id, state.created, options, { reasoning_content: event.text }, null)
      )
    );
    return;
  }
  if (event.kind === "citations") {
    const priorUrls = new Set(
      state.citations.annotations.map((annotation) => annotation.url_citation.url)
    );
    const previousStatus = state.citations.metadata.status;
    state.citations = mergeCitationResults(state.citations, event.result);
    const annotations = state.citations.annotations.filter(
      (annotation) => !priorUrls.has(annotation.url_citation.url)
    );
    if (annotations.length > 0 || state.citations.metadata.status !== previousStatus) {
      state.pendingChunks.push(
        encodeStreamEvent(
          state,
          makeChunk(
            state.id,
            state.created,
            options,
            annotations.length > 0 ? { annotations } : {},
            null,
            undefined,
            state.citations
          )
        )
      );
    }
    return;
  }
  if (event.kind === "metadata") {
    state.pendingChunks.push(
      encodeStreamEvent(
        state,
        makeChunk(state.id, state.created, options, {}, null, {
          type: event.eventType,
          data: event.data,
        })
      )
    );
    return;
  }

  await state.iterator.return?.();
  state.outcome = "completed";
  notifyComplete(options, { assistantText: state.assistantText, stopReason: event.stopReason });
  state.pendingChunks.push(
    encodeStreamEvent(
      state,
      makeChunk(
        state.id,
        state.created,
        options,
        {},
        openAiFinishReason(event.stopReason),
        undefined,
        state.citations
      )
    )
  );
  state.pendingChunks.push(state.encoder.encode("data: [DONE]\n\n"));
  state.terminal = true;
}

function queueStreamFailure(
  state: StreamingState,
  options: ClaudeWebStreamOptions,
  error: unknown
): void {
  options.log?.error?.("CLAUDE-WEB-STREAM", protocolDiagnostic(error));
  failStreamOnce(state, options);
  state.pendingChunks.push(encodeStreamEvent(state, protocolErrorBody()));
  state.pendingChunks.push(state.encoder.encode("data: [DONE]\n\n"));
  state.terminal = true;
}

async function pullStreamingChunk(
  state: StreamingState,
  options: ClaudeWebStreamOptions,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  if (state.closed || flushStreamChunk(state, controller)) return;
  if (state.terminal) {
    closeStreamIfDrained(state, controller);
    return;
  }

  try {
    while (!state.terminal) {
      const next = await state.iterator.next();
      if (state.control.cancelled) return;
      if (next.done) {
        throw new ClaudeWebProtocolError("Claude Web stream ended without a terminal event");
      }
      await queueSemanticEvent(state, next.value, options);
      if (state.pendingChunks.length > 0) {
        flushStreamChunk(state, controller);
        return;
      }
    }
  } catch (error) {
    if (state.control.cancelled) return;
    queueStreamFailure(state, options, error);
    flushStreamChunk(state, controller);
  }
}

async function cancelStreaming(
  state: StreamingState,
  options: ClaudeWebStreamOptions,
  reason: unknown
): Promise<void> {
  if (state.closed) return;
  state.terminal = true;
  state.control.cancelled = true;
  failStreamOnce(state, options);
  if (state.control.reader) await state.control.reader.cancel(reason).catch(() => {});
  try {
    await state.iterator.return?.();
  } catch {
    // Cancellation is best-effort; the source reader was already cancelled.
  }
  state.closed = true;
}

function createStreamingResponse(
  source: ReadableStream<Uint8Array>,
  options: ClaudeWebStreamOptions
): Response {
  const control: StreamControl = { reader: null, cancelled: false };
  const state: StreamingState = {
    encoder: new TextEncoder(),
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    control,
    iterator: parseClaudeWebEvents(source, control)[Symbol.asyncIterator](),
    pendingChunks: [],
    assistantText: "",
    citations: mergeCitationResults(),
    outcome: "pending",
    terminal: false,
    closed: false,
  };

  const output = new ReadableStream<Uint8Array>({
    pull(controller) {
      return pullStreamingChunk(state, options, controller);
    },
    cancel(reason) {
      return cancelStreaming(state, options, reason);
    },
  });

  const headers = responseHeaders("text/event-stream", options.responseMetadata);
  headers.set("Connection", "keep-alive");
  return new Response(output, { status: 200, headers });
}

export async function createClaudeWebResponse(
  source: ReadableStream<Uint8Array>,
  options: ClaudeWebStreamOptions
): Promise<Response> {
  return options.stream
    ? createStreamingResponse(source, options)
    : createBufferedResponse(source, options);
}
