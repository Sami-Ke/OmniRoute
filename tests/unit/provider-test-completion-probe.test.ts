import test from "node:test";
import assert from "node:assert/strict";

const { runCompletionProbe } =
  await import("../../src/app/api/providers/[id]/test/completionProbe.ts");

const CHATGPT_CONNECTION = {
  id: "conn-1",
  provider: "chatgpt-web",
};

const okCredentials = async () => ({ apiKey: "cookie", connectionId: "conn-1" });

test("completion probe uses the ChatGPT registry fallback when no model is configured", async () => {
  let seenModel: string | null = null;
  const result = await runCompletionProbe(CHATGPT_CONNECTION, null, {
    getCredentials: async (_provider, _connectionId, model) => {
      seenModel = model;
      return { apiKey: "cookie", connectionId: "conn-1" };
    },
    runChat: async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  });

  assert.equal(result.valid, true);
  assert.equal(result.model, "gpt-5.5");
  assert.equal(seenModel, "gpt-5.5");
});

test("completion probe prefers an explicit model over the fallback", async () => {
  let seenModel: string | null = null;
  const result = await runCompletionProbe(CHATGPT_CONNECTION, "gpt-5.5-thinking", {
    getCredentials: async (_provider, _connectionId, model) => {
      seenModel = model;
      return { apiKey: "cookie", connectionId: "conn-1" };
    },
    runChat: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  });

  assert.equal(result.valid, true);
  assert.equal(result.model, "gpt-5.5-thinking");
  assert.equal(seenModel, "gpt-5.5-thinking");
});

test("completion probe reports Sentinel-style failures with the upstream status", async () => {
  const result = await runCompletionProbe(
    { ...CHATGPT_CONNECTION, defaultModel: "gpt-5.5" },
    null,
    {
      getCredentials: okCredentials,
      runChat: async () =>
        new Response(
          JSON.stringify({
            error: { message: "ChatGPT blocked the request (Sentinel/Turnstile required)." },
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        ),
    }
  );

  assert.equal(result.valid, false);
  assert.equal(result.statusCode, 403);
  assert.match(result.error || "", /Sentinel/);
});

test("completion probe keeps the actionable no-model error for other providers", async () => {
  const result = await runCompletionProbe(
    { id: "conn-2", provider: "some-provider-without-a-default" },
    null,
    {
      getCredentials: okCredentials,
      runChat: async () => {
        throw new Error("must not be called");
      },
    }
  );

  assert.equal(result.valid, false);
  assert.match(result.error || "", /completionModel|default model/);
});
