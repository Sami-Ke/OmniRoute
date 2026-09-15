import test from "node:test";
import assert from "node:assert/strict";
import {
  __setBrowserGrokChatOverrideForTesting,
  translateBrowserGrokEvent,
} from "../../open-sse/services/browserGrokChat.ts";
import { GrokWebExecutor } from "../../open-sse/executors/grok-web.ts";

function parseLines(lines: string[]): unknown[] {
  return lines.map((line) => JSON.parse(line));
}

test.afterEach(() => {
  __setBrowserGrokChatOverrideForTesting(null);
  delete process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT;
});

test("translates current Grok WebSocket assistant chunks to legacy text events", () => {
  const lines = translateBrowserGrokEvent({
    type: "response.chunk",
    response_id: "resp-1",
    chunk: {
      text: { text: "Hello", channel: "CHANNEL_ASSISTANT_RESPONSE" },
    },
  });

  assert.deepEqual(parseLines(lines), [
    { result: { response: { token: "Hello", responseId: "resp-1" } } },
  ]);
});

test("translates Grok web-search tool result pages without treating arbitrary text URLs as citations", () => {
  const lines = translateBrowserGrokEvent({
    type: "response.chunk",
    chunk: {
      text: { text: "Source-backed answer", channel: "CHANNEL_ASSISTANT_RESPONSE" },
      tool_result: {
        web_search: {
          webpages: [
            { url: "https://example.com/a", title: "A", snippet: "first" },
            { url: "not-a-url", title: "ignored by the shared normalizer" },
          ],
        },
      },
    },
  });

  type BrowserGrokEvent = {
    result: {
      response: {
        token?: string;
        webSearchResults?: {
          results?: Array<{ url?: string; title?: string; snippet?: string }>;
        };
      };
    };
  };
  const parsed = parseLines(lines) as BrowserGrokEvent[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].result.response.webSearchResults.results[0].url, "https://example.com/a");
  assert.equal(parsed[1].result.response.token, "Source-backed answer");
});

test("keeps reasoning/notetaker text marked as thinking", () => {
  const lines = translateBrowserGrokEvent({
    type: "response.chunk",
    chunk: {
      text: { text: "internal", channel: "CHANNEL_ASSISTANT_NOTETAKER_HEADER" },
    },
  });

  assert.deepEqual(parseLines(lines), [
    { result: { response: { token: "internal", isThinking: true } } },
  ]);
});

test("surfaces browser response errors as structured upstream events", () => {
  const lines = translateBrowserGrokEvent({
    type: "response.error",
    error: { message: "browser upstream failed" },
  });

  assert.deepEqual(parseLines(lines), [{ error: { message: "browser upstream failed" } }]);
});

test("routes an opted-in Grok executor request through the browser event adapter", async () => {
  process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT = "1";
  __setBrowserGrokChatOverrideForTesting(async () => ({
    status: 200,
    contentType: "application/x-ndjson",
    body: Buffer.from(
      [
        { result: { response: { token: "Answer" } } },
        {
          result: {
            response: {
              webSearchResults: {
                results: [{ url: "https://example.com/source", title: "Source" }],
              },
            },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n"
    ),
    isStealth: false,
    timing: {
      acquireContextMs: 0,
      navigateMs: 0,
      submitMs: 0,
      captureResponseMs: 0,
      totalMs: 0,
    },
  }));

  const result = await new GrokWebExecutor().execute({
    model: "grok-4.1-fast",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: "sso=test" },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as {
    choices: Array<{
      message: {
        content: string;
        annotations: Array<{
          type: string;
          url_citation: { url: string; title: string };
        }>;
      };
    }>;
  };
  assert.equal(json.choices[0].message.content, "Answer");
  assert.deepEqual(json.choices[0].message.annotations, [
    {
      type: "url_citation",
      url_citation: { url: "https://example.com/source", title: "Source" },
    },
  ]);
});
