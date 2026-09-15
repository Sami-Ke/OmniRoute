/**
 * Browser-owned ChatGPT Web transport.
 *
 * ChatGPT's page already owns the session exchange, Sentinel state, and the
 * browser fingerprint. This adapter deliberately captures the page's own
 * conversation SSE response instead of replaying the cookie through Node.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  browserBackedChat,
  type BrowserRequestTemplate,
  type BrowserBackedChatResult,
} from "./browserBackedChat.ts";

const CHATGPT_PAGE_URL = "https://chatgpt.com/";
const CHATGPT_CHAT_URL = "https://chatgpt.com/backend-api/f/conversation";
const CHATGPT_ANON_CHAT_URL = "https://chatgpt.com/backend-anon/f/conversation";
const CHATGPT_COOKIE_DOMAIN = ".chatgpt.com";
const DEFAULT_CHATGPT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

type BrowserChatGptPage = import("playwright").Page;

function chatGptSsePayloads(body: Buffer): unknown[] {
  const payloads: unknown[] = [];
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trimStart();
    if (!payload || payload === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(payload) as unknown);
    } catch {
      // The main executor owns detailed SSE diagnostics. This helper only
      // needs to decide whether a handoff has already produced an answer.
    }
  }
  return payloads;
}

function chatGptPartHasText(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(chatGptPartHasText);
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return [obj.text, obj.content, obj.parts].some(chatGptPartHasText);
}

function chatGptBodyHasAssistantContent(body: Buffer): boolean {
  if (/^event:\s*delta\s*$/m.test(body.toString("utf8"))) return true;
  return chatGptSsePayloads(body).some((payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const message = (payload as Record<string, unknown>).message;
    if (!message || typeof message !== "object") return false;
    const author = (message as Record<string, unknown>).author;
    return (
      !!author &&
      typeof author === "object" &&
      (author as Record<string, unknown>).role === "assistant" &&
      chatGptPartHasText((message as Record<string, unknown>).content)
    );
  });
}

function chatGptHandoffInfo(body: Buffer): { token: string; conversationId: string } | null {
  let token: string | null = null;
  let conversationId: string | null = null;
  for (const payload of chatGptSsePayloads(body)) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const obj = payload as Record<string, unknown>;
    if (obj.type === "resume_conversation_token" && typeof obj.token === "string") {
      token = obj.token;
    }
    if (typeof obj.conversation_id === "string") conversationId = obj.conversation_id;
  }
  return token && conversationId ? { token, conversationId } : null;
}

async function recoverChatGptHandoffInBrowser(
  page: BrowserChatGptPage,
  body: Buffer
): Promise<{ status: number; contentType: string | null; body: Buffer } | null> {
  if (chatGptBodyHasAssistantContent(body)) return null;
  const handoff = chatGptHandoffInfo(body);
  if (!handoff) return null;

  for (const offset of [0, 1, 2]) {
    const resumed = await page.evaluate(
      async ({ token, conversationId, resumeOffset }) => {
        const response = await fetch("/backend-api/f/conversation/resume", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            "x-conduit-token": token,
            "X-OpenAI-Target-Path": "/backend-api/f/conversation/resume",
            "X-OpenAI-Target-Route": "/backend-api/f/conversation/resume",
          },
          body: JSON.stringify({ conversation_id: conversationId, offset: resumeOffset }),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          text: await response.text(),
        };
      },
      { token: handoff.token, conversationId: handoff.conversationId, resumeOffset: offset }
    );
    const resumedBody = Buffer.from(resumed.text, "utf8");
    if (
      resumed.status >= 200 &&
      resumed.status < 300 &&
      resumedBody.length > 0 &&
      chatGptBodyHasAssistantContent(resumedBody)
    ) {
      return {
        status: resumed.status,
        contentType: resumed.contentType,
        body: resumedBody,
      };
    }
  }
  return null;
}

export interface BrowserChatGptRequest {
  cookieString: string;
  userMessage: string;
  /** ChatGPT internal model slug selected by the OmniRoute API request. */
  modelSlug?: string;
  userAgent?: string | null;
  signal?: AbortSignal | null;
  browserRequestTemplate?: BrowserRequestTemplate;
}

export function transformChatGptBrowserRequest(
  request: BrowserRequestTemplate,
  modelSlug?: string
): BrowserRequestTemplate {
  if (!modelSlug) return request;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body) as unknown;
  } catch {
    throw new Error("ChatGPT browser request body is not JSON; cannot apply the selected model");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ChatGPT browser request body has an invalid shape; cannot apply the selected model");
  }
  return {
    ...request,
    body: JSON.stringify({ ...(parsed as Record<string, unknown>), model: modelSlug }),
  };
}

let testOverride: ((req: BrowserChatGptRequest) => Promise<BrowserBackedChatResult>) | null = null;

export function __setBrowserChatGptOverrideForTesting(
  fn: ((req: BrowserChatGptRequest) => Promise<BrowserBackedChatResult>) | null
): void {
  testOverride = fn;
}

export function shouldUseChatGptBrowserTransport(): boolean {
  const flag = process.env.OMNIROUTE_CHATGPT_BROWSER_TRANSPORT;
  return flag === "1" || flag === "true" || flag === "on";
}

function poolKeyFor(cookieString: string): string {
  return `chatgpt-web-browser:${createHash("sha256").update(cookieString).digest("hex").slice(0, 16)}`;
}

export async function browserChatGpt(
  req: BrowserChatGptRequest
): Promise<BrowserBackedChatResult> {
  if (testOverride) return testOverride(req);
  return browserBackedChat({
    poolKey: poolKeyFor(req.cookieString),
    chatUrl: CHATGPT_CHAT_URL,
    chatUrlAlternatives: [CHATGPT_ANON_CHAT_URL],
    chatPageUrl: CHATGPT_PAGE_URL,
    userMessage: req.userMessage,
    cookieString: req.cookieString,
    cookieDomain: CHATGPT_COOKIE_DOMAIN,
    chatUrlMatchDomain: "chatgpt.com",
    userAgent: req.userAgent?.trim() || DEFAULT_CHATGPT_BROWSER_USER_AGENT,
    locale: "en-US",
    inputSelector: '[contenteditable="true"]:visible',
    postSubmitWaitMs: 15_000,
    signal: req.signal,
    reuseContext: true,
    replayRequestInBrowser: true,
    browserRequestTemplate: req.browserRequestTemplate,
    transformRequest: req.modelSlug
      ? (request) => transformChatGptBrowserRequest(request, req.modelSlug)
      : undefined,
    resolveResponseBody: ({ page, body }) => recoverChatGptHandoffInBrowser(page, body),
  });
}
