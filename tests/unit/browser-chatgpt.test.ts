import test from "node:test";
import assert from "node:assert/strict";
import { browserReplayHeaders } from "../../open-sse/services/browserBackedChat.ts";
import {
  __setBrowserChatGptOverrideForTesting,
  transformChatGptBrowserRequest,
} from "../../open-sse/services/browserChatGpt.ts";
import { ChatGptWebExecutor } from "../../open-sse/executors/chatgpt-web.ts";

function chatGptSse(): Buffer {
  const events = [
    {
      message: {
        id: "assistant-1",
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["OK"] },
        status: "in_progress",
      },
      conversation_id: "conversation-1",
    },
    {
      message: {
        id: "assistant-1",
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["OK"] },
        status: "finished_successfully",
      },
      conversation_id: "conversation-1",
    },
  ];
  return Buffer.from(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  );
}

function chatGptDeltaEncodedSse(): Buffer {
  const initial = {
    message: {
      id: "assistant-delta-1",
      author: { role: "assistant" },
      content: { content_type: "text", parts: [""] },
      status: "in_progress",
    },
    conversation_id: "conversation-delta-1",
    error: null,
    error_code: null,
  };
  const snapshot = {
    ...initial,
    message: { ...initial.message, content: { content_type: "text", parts: ["O"] } },
  };
  const events = [
    `event: delta_encoding\ndata: "v1"\n\n`,
    `event: delta\ndata: ${JSON.stringify({ p: "", o: "add", v: initial, c: 0 })}\n\n`,
    `event: delta\ndata: ${JSON.stringify({ v: snapshot, c: 1 })}\n\n`,
    `event: delta\ndata: ${JSON.stringify({
      o: "patch",
      v: [
        { p: "/message/content/parts/0", o: "append", v: "K" },
        { p: "/message/status", o: "replace", v: "finished_successfully" },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ type: "message_stream_complete", conversation_id: "conversation-delta-1" })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return Buffer.from(events.join(""));
}

interface TestChatCompletionResponse {
  choices: Array<{
    message: {
      content: unknown;
      role?: string;
    };
  }>;
}

test.afterEach(() => {
  __setBrowserChatGptOverrideForTesting(null);
  delete process.env.OMNIROUTE_CHATGPT_BROWSER_TRANSPORT;
});

test("browser replay keeps auth/challenge headers but lets the page own browser headers", () => {
  assert.deepEqual(
    browserReplayHeaders({
      Authorization: "redacted-auth",
      "X-OpenAI-Sentinel-Proof": "redacted-proof",
      "X-Conduit-Token": "redacted-conduit",
      "Content-Type": "application/json",
      Cookie: "redacted-cookie",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "User-Agent": "redacted-user-agent",
      "Sec-Fetch-Site": "same-origin",
    }),
    {
      Authorization: "redacted-auth",
      "X-OpenAI-Sentinel-Proof": "redacted-proof",
      "X-Conduit-Token": "redacted-conduit",
      "Content-Type": "application/json",
    }
  );
});

test("ChatGPT browser replay replaces only the selected model field", () => {
  const request = transformChatGptBrowserRequest(
    {
      url: "https://chatgpt.com/backend-anon/f/conversation",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "next",
        model: "gpt-5-5",
        messages: [{ role: "user", content: { parts: ["redacted"] } }],
      }),
    },
    "gpt-5-6-thinking"
  );
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.equal(body.action, "next");
  assert.equal(body.model, "gpt-5-6-thinking");
  assert.deepEqual(body.messages, [{ role: "user", content: { parts: ["redacted"] } }]);
});

test("ChatGPT executor passes the resolved model slug to browser transport", async () => {
  process.env.OMNIROUTE_CHATGPT_BROWSER_TRANSPORT = "1";
  let observedModelSlug: string | undefined;
  __setBrowserChatGptOverrideForTesting(async (request) => {
    observedModelSlug = request.modelSlug;
    return {
      status: 200,
      contentType: "text/event-stream",
      body: chatGptSse(),
      isStealth: false,
      timing: {
        acquireContextMs: 0,
        navigateMs: 0,
        submitMs: 0,
        captureResponseMs: 0,
        totalMs: 0,
      },
    };
  });

  const result = await new ChatGptWebExecutor().execute({
    model: "gpt-5.6-thinking",
    body: { messages: [{ role: "user", content: "Reply with OK only" }] },
    stream: false,
    credentials: { apiKey: "browser-cookie" },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  assert.equal(observedModelSlug, "gpt-5-6-thinking");
});

test("ChatGPT executor can consume a browser-owned SSE response without TLS session exchange", async () => {
  process.env.OMNIROUTE_CHATGPT_BROWSER_TRANSPORT = "1";
  let calls = 0;
  __setBrowserChatGptOverrideForTesting(async () => {
    calls++;
    return {
      status: 200,
      contentType: "text/event-stream",
      body: chatGptSse(),
      isStealth: false,
      timing: {
        acquireContextMs: 0,
        navigateMs: 0,
        submitMs: 0,
        captureResponseMs: 0,
        totalMs: 0,
      },
    };
  });

  const result = await new ChatGptWebExecutor().execute({
    model: "gpt-5.5",
    body: { messages: [{ role: "user", content: "Reply with OK only" }] },
    stream: false,
    credentials: { apiKey: "browser-cookie" },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });

  assert.equal(calls, 1);
  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as TestChatCompletionResponse;
  assert.equal(json.choices[0].message.content, "OK");
  assert.equal(json.choices[0].message.role, "assistant");
});

test("ChatGPT executor decodes v1 delta-encoded browser SSE responses", async () => {
  process.env.OMNIROUTE_CHATGPT_BROWSER_TRANSPORT = "1";
  __setBrowserChatGptOverrideForTesting(async () => ({
    status: 200,
    contentType: "text/event-stream",
    body: chatGptDeltaEncodedSse(),
    isStealth: false,
    timing: {
      acquireContextMs: 0,
      navigateMs: 0,
      submitMs: 0,
      captureResponseMs: 0,
      totalMs: 0,
    },
  }));

  const result = await new ChatGptWebExecutor().execute({
    model: "gpt-5.5",
    body: { messages: [{ role: "user", content: "Reply with OK only" }] },
    stream: false,
    credentials: { apiKey: "browser-cookie" },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as TestChatCompletionResponse;
  assert.equal(json.choices[0].message.content, "OK");
  assert.equal(typeof json.choices[0].message.content, "string");
});
