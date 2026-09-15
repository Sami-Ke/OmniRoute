/**
 * Browser-owned Grok Web transport.
 *
 * Grok's current web client sends chat input over the page's WebSocket
 * (`/ws/mgw/`). A TLS client that replays the page cookies cannot reproduce
 * the browser session, so this adapter keeps the request inside Chromium and
 * converts the browser event stream into the legacy NDJSON shape consumed by
 * GrokWebExecutor.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  acquireBrowserContext,
  openPage,
  type PooledContext,
} from "./browserPool.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

const GROK_CHAT_PAGE_URL = "https://grok.com/";
const GROK_COOKIE_DOMAIN = ".grok.com";
const DEFAULT_GROK_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const BROWSER_RESPONSE_TIMEOUT_MS = 45_000;
const GROK_RESPONSE_CHANNEL = "CHANNEL_ASSISTANT_RESPONSE";

export interface BrowserGrokChatRequest {
  cookieString: string;
  userMessage: string;
  userAgent?: string | null;
  signal?: AbortSignal | null;
  poolKey?: string;
}

export interface BrowserGrokChatResult {
  status: number;
  contentType: string;
  body: Buffer;
  isStealth: boolean;
  timing: {
    acquireContextMs: number;
    navigateMs: number;
    submitMs: number;
    captureResponseMs: number;
    totalMs: number;
  };
}

type JsonRecord = Record<string, unknown>;

let testOverride: ((req: BrowserGrokChatRequest) => Promise<BrowserGrokChatResult>) | null = null;

export function __setBrowserGrokChatOverrideForTesting(
  fn: ((req: BrowserGrokChatRequest) => Promise<BrowserGrokChatResult>) | null
): void {
  testOverride = fn;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function framePayload(frame: unknown): string {
  if (typeof frame === "string") return frame;
  if (Buffer.isBuffer(frame)) return frame.toString("utf8");
  if (frame instanceof Uint8Array) return Buffer.from(frame).toString("utf8");
  const record = asRecord(frame);
  const payload = record?.payload;
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString("utf8");
  return "";
}

function responseId(event: JsonRecord): string | undefined {
  return typeof event.response_id === "string" ? event.response_id : undefined;
}

function addLegacyTextEvent(
  lines: string[],
  text: string,
  event: JsonRecord,
  isThinking = false
): void {
  if (!text) return;
  lines.push(
    JSON.stringify({
      result: {
        response: {
          token: text,
          ...(isThinking ? { isThinking: true } : {}),
          ...(responseId(event) ? { responseId: responseId(event) } : {}),
        },
      },
    })
  );
}

function addLegacySearchResultEvent(lines: string[], event: JsonRecord, chunk: JsonRecord): void {
  const toolResult = asRecord(chunk.tool_result);
  const webSearch = asRecord(toolResult?.web_search);
  const webpages = Array.isArray(webSearch?.webpages) ? webSearch.webpages : [];
  const results = webpages.filter((item): item is JsonRecord => !!asRecord(item));
  if (results.length === 0) return;

  lines.push(
    JSON.stringify({
      result: {
        response: {
          webSearchResults: { results },
          ...(responseId(event) ? { responseId: responseId(event) } : {}),
        },
      },
    })
  );
}

/**
 * Convert one current Grok browser event into the NDJSON event(s) understood
 * by the existing citation/text parser. This is exported as a pure seam so
 * the browser transport can be tested without launching Chromium.
 */
export function translateBrowserGrokEvent(eventValue: unknown): string[] {
  const event = asRecord(eventValue);
  if (!event) return [];

  const lines: string[] = [];
  const eventType = typeof event.type === "string" ? event.type : "";

  if (eventType === "response.error") {
    const error = asRecord(event.error);
    const message =
      (typeof error?.message === "string" && error.message) || "Grok browser response failed";
    lines.push(JSON.stringify({ error: { message } }));
    return lines;
  }

  if (eventType === "response.chunk") {
    const chunk = asRecord(event.chunk);
    if (!chunk) return lines;

    addLegacySearchResultEvent(lines, event, chunk);

    const textValue = chunk.text;
    if (typeof textValue === "string") {
      addLegacyTextEvent(lines, textValue, event);
      return lines;
    }

    const textRecord = asRecord(textValue);
    const text = typeof textRecord?.text === "string" ? textRecord.text : "";
    const channel = typeof textRecord?.channel === "string" ? textRecord.channel : "";
    if (channel === GROK_RESPONSE_CHANNEL) {
      addLegacyTextEvent(lines, text, event);
    } else if (text && /REASON|THINKING|NOTETAKER/i.test(channel)) {
      // Notetaker headers are intentionally suppressed by the legacy parser's
      // thinking cleanup; preserving them as thinking keeps the adapter from
      // leaking them into visible answer text.
      addLegacyTextEvent(lines, text, event, true);
    }
    return lines;
  }

  // Some browser builds emit the final answer only on output_text.done. Avoid
  // duplicating normal chunked text, but retain a fallback for shape drift.
  if (eventType === "response.output_text.done" && typeof event.text === "string") {
    addLegacyTextEvent(lines, event.text, event);
  }

  return lines;
}

function browserError(status: number, message: string): BrowserGrokChatResult {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ error: { message, type: "upstream_error" } })),
    isStealth: false,
    timing: {
      acquireContextMs: 0,
      navigateMs: 0,
      submitMs: 0,
      captureResponseMs: 0,
      totalMs: 0,
    },
  };
}

function poolKeyFor(cookieString: string, requestedKey?: string): string {
  if (requestedKey) return requestedKey;
  return `grok-web-browser:${createHash("sha256").update(cookieString).digest("hex").slice(0, 16)}`;
}

function createDoneWaiter(signal: AbortSignal | null | undefined): {
  promise: Promise<void>;
  resolve: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  let settled = false;
  let resolvePromise: () => void = () => {};
  let rejectPromise: (error: Error) => void = () => {};

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    if (error) rejectPromise(error);
    else resolvePromise();
  };

  timer = setTimeout(
    () => finish(new Error("Grok browser response timed out")),
    BROWSER_RESPONSE_TIMEOUT_MS
  );
  if (signal) {
    abortListener = () => finish(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  return {
    promise,
    resolve: () => finish(),
    cancel: () => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    },
  };
}

async function runBrowserGrokChat(req: BrowserGrokChatRequest): Promise<BrowserGrokChatResult> {
  const startedAt = Date.now();
  if (!req.cookieString.trim()) {
    return browserError(401, "Grok browser transport requires an sso cookie");
  }

  const acquireStartedAt = Date.now();
  let pooled: PooledContext;
  try {
    pooled = await acquireBrowserContext(poolKeyFor(req.cookieString, req.poolKey), {
      cookieDomain: GROK_COOKIE_DOMAIN,
      cookieString: req.cookieString,
      warmupUrl: GROK_CHAT_PAGE_URL,
      userAgent: req.userAgent?.trim() || DEFAULT_GROK_BROWSER_USER_AGENT,
      locale: "en-US",
    });
  } catch (error) {
    return browserError(
      502,
      sanitizeErrorMessage(`Grok browser context failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  }
  const acquireContextMs = Date.now() - acquireStartedAt;

  const page = await openPage(pooled);
  const lines: string[] = [];
  let responseStarted = false;
  let responseError: string | null = null;
  let sawVisibleText = false;
  const done = createDoneWaiter(req.signal);

  const onWebSocket = (socket: import("playwright").WebSocket) => {
    socket.on("framereceived", (frame) => {
      const raw = framePayload(frame);
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const event = asRecord(asRecord(parsed)?.event);
      if (!event) return;
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "response.error") {
        const error = asRecord(event.error);
        responseError =
          (typeof error?.message === "string" && error.message) ||
          "Grok browser response failed";
        responseStarted = true;
        done.resolve();
        return;
      }
      if (eventType === "response.created") responseStarted = true;
      if (responseStarted) {
        // Current Grok sends visible text in response.chunk and may also send
        // response.output_text.done. The latter is a completion summary, not
        // a second delta; suppress it after the first visible chunk.
        if (!(eventType === "response.output_text.done" && sawVisibleText)) {
          const translated = translateBrowserGrokEvent(event);
          lines.push(...translated);
          if (eventType === "response.chunk" && translated.some((line) => {
            try {
              const parsedLine = JSON.parse(line) as JsonRecord;
              const token = asRecord(asRecord(parsedLine.result)?.response)?.token;
              return typeof token === "string" && token.length > 0;
            } catch {
              return false;
            }
          })) {
            sawVisibleText = true;
          }
        }
      }
      if (eventType === "response.done" && responseStarted) {
        done.resolve();
      }
    });
  };

  page.on("websocket", onWebSocket);
  try {
    const navigateStartedAt = Date.now();
    const navigation = await page.goto(GROK_CHAT_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
      signal: req.signal ?? undefined,
    });
    const navigateMs = Date.now() - navigateStartedAt;

    const input = page.locator('[contenteditable="true"]:visible').first();
    await input.waitFor({ state: "visible", timeout: 15_000, signal: req.signal ?? undefined });
    await input.fill(req.userMessage);

    const submitStartedAt = Date.now();
    await input.press("Enter");
    const submitMs = Date.now() - submitStartedAt;
    await done.promise;
    const captureResponseMs = Date.now() - submitStartedAt;

    const navStatus = navigation?.status() ?? 200;
    const status = navStatus >= 400 ? navStatus : 200;
    if (responseError) {
      return {
        ...browserError(502, sanitizeErrorMessage(`Grok browser response failed: ${responseError}`)),
        isStealth: pooled.isStealth,
        timing: { acquireContextMs, navigateMs, submitMs, captureResponseMs, totalMs: Date.now() - startedAt },
      };
    }
    if (lines.length === 0) {
      return {
        ...browserError(502, "Grok browser completed without a response event"),
        isStealth: pooled.isStealth,
        timing: { acquireContextMs, navigateMs, submitMs, captureResponseMs, totalMs: Date.now() - startedAt },
      };
    }
    return {
      status,
      contentType: "application/x-ndjson",
      body: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
      isStealth: pooled.isStealth,
      timing: { acquireContextMs, navigateMs, submitMs, captureResponseMs, totalMs: Date.now() - startedAt },
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    return {
      ...browserError(isAbort ? 504 : 502, sanitizeErrorMessage(`Grok browser transport failed: ${error instanceof Error ? error.message : String(error)}`)),
      isStealth: pooled.isStealth,
      timing: { acquireContextMs, navigateMs: 0, submitMs: 0, captureResponseMs: 0, totalMs: Date.now() - startedAt },
    };
  } finally {
    done.cancel();
    await page.close().catch(() => {});
  }
}

export async function browserGrokChat(req: BrowserGrokChatRequest): Promise<BrowserGrokChatResult> {
  if (testOverride) return testOverride(req);
  return runBrowserGrokChat(req);
}
