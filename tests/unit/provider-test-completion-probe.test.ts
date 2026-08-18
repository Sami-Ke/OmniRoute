import test from "node:test";
import assert from "node:assert/strict";

// Real-completion connection probe (mode:"completion"). Motivating incident: a
// chatgpt-web connection whose session cookie passed the auth-only test while
// every real conversation was 403-blocked by Sentinel/Turnstile — the dashboard
// showed "active" for a connection that could not serve a single request. The
// probe sends one real non-streaming completion pinned to the connection so the
// recorded status reflects live-traffic behavior.
const { runCompletionProbe } = await import(
  "../../src/app/api/providers/[id]/test/completionProbe.ts"
);

const CONNECTION = {
  id: "conn-1",
  provider: "chatgpt-web",
  defaultModel: "gpt-5.5",
};

const okCredentials = async () => ({ apiKey: "cookie", connectionId: "conn-1" });

test("completion probe: HTTP 200 with content → valid, content surfaced", async () => {
  const seen: Record<string, unknown> & { chatOptions?: Record<string, unknown> } = {};
  const result = await runCompletionProbe(CONNECTION, null, {
    getCredentials: async (provider, connectionId, model) => {
      Object.assign(seen, { provider, connectionId, model });
      return { apiKey: "cookie", connectionId };
    },
    runChat: async (options) => {
      seen.chatOptions = options;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.content, "OK");
  assert.equal(result.model, "gpt-5.5");
  // Pinned to the connection under test, single-shot semantics
  assert.equal(seen.connectionId, "conn-1");
  assert.equal(seen.chatOptions.connectionId, "conn-1");
  assert.equal(seen.chatOptions.skipUpstreamRetry, true);
  assert.equal(seen.chatOptions.body.stream, false);
});

test("completion probe: Sentinel-style 403 → invalid with upstream error and status", async () => {
  const result = await runCompletionProbe(CONNECTION, null, {
    getCredentials: okCredentials,
    runChat: async () =>
      new Response(
        JSON.stringify({
          error: { message: "ChatGPT blocked the request (Sentinel/Turnstile required)." },
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      ),
  });

  assert.equal(result.valid, false);
  assert.equal(result.statusCode, 403);
  assert.match(result.error, /Sentinel/);
});

test("completion probe: {success, response} envelope from handleChatCore is unwrapped", async () => {
  const result = await runCompletionProbe(CONNECTION, "gpt-5.5-mini", {
    getCredentials: okCredentials,
    runChat: async () => ({
      success: true,
      response: new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    }),
  });

  assert.equal(result.valid, true);
  assert.equal(result.model, "gpt-5.5-mini");
});

test("completion probe: no resolvable model → invalid with actionable error", async () => {
  const result = await runCompletionProbe({ id: "c", provider: "chatgpt-web" }, null, {
    getCredentials: okCredentials,
    runChat: async () => {
      throw new Error("must not be called");
    },
  });

  assert.equal(result.valid, false);
  assert.match(result.error, /completionModel|default model/);
});

test("completion probe: null credentials → invalid, chat never dispatched", async () => {
  let chatCalled = false;
  const result = await runCompletionProbe(CONNECTION, null, {
    getCredentials: async () => null,
    runChat: async () => {
      chatCalled = true;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.valid, false);
  assert.equal(chatCalled, false);
  assert.match(result.error, /credentials/i);
});

test("completion probe: hung upstream → times out with bounded latency", async () => {
  const result = await runCompletionProbe(CONNECTION, null, {
    getCredentials: okCredentials,
    runChat: () => new Promise(() => {}),
    timeoutMs: 50,
  });

  assert.equal(result.valid, false);
  assert.match(result.error, /timed out/);
});

test("POST body validation rejects an unknown mode before touching any connection", async () => {
  const route = await import("../../src/app/api/providers/[id]/test/route.ts");
  const response = await route.POST(
    new Request("http://localhost/api/providers/x/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "definitely-not-a-mode" }),
    }),
    { params: Promise.resolve({ id: "x" }) }
  );
  assert.equal(response.status, 400);
});
