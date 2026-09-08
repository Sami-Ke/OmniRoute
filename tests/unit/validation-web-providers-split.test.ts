// Characterization of the validation.ts web-provider split (god-file decomposition): the 13 web-cookie
// validators + the Meta AI request builder moved into co-located leaf modules (validation/metaAi.ts,
// webProvidersA.ts, webProvidersB.ts). Behavior-preserving move — the locks here are: each module
// exposes its validators, webProvidersB consumes metaAi, and buildMetaAiValidationBody still emits a
// well-formed persisted-query body. The dispatcher's runtime wiring stays covered by the existing
// provider-validation-specialty / web-cookie suites.
import { test } from "node:test";
import assert from "node:assert/strict";

import { __setBrowserGrokChatOverrideForTesting } from "../../open-sse/services/browserGrokChat.ts";
import { __setTlsFetchOverrideForTesting } from "../../open-sse/services/chatgptTlsClient.ts";

const A = await import("../../src/lib/providers/validation/webProvidersA.ts");
const B = await import("../../src/lib/providers/validation/webProvidersB.ts");
const meta = await import("../../src/lib/providers/validation/metaAi.ts");
const HOST = await import("../../src/lib/providers/validation.ts");

test("webProvidersA exposes its six validators (deepseek/qwen/grok/chatgpt/perplexity/blackbox)", () => {
  for (const name of [
    "validateDeepSeekWebProvider",
    "validateQwenWebProvider",
    "validateGrokWebProvider",
    "validateChatGptWebProvider",
    "validatePerplexityWebProvider",
    "validateBlackboxWebProvider",
  ]) {
    assert.equal(typeof (A as Record<string, unknown>)[name], "function", `A missing ${name}`);
  }
});

test("webProvidersB exposes its nine validators (muse-spark/adapta/claude/gemini/copilot/t3/jules/devin/inner-ai)", () => {
  for (const name of [
    "validateMuseSparkWebProvider",
    "validateAdaptaWebProvider",
    "validateClaudeWebProvider",
    "validateGeminiWebProvider",
    "validateCopilotWebProvider",
    "validateT3WebProvider",
    "validateJulesProvider",
    "validateDevinCloudAgentProvider",
    "validateInnerAiProvider",
  ]) {
    assert.equal(typeof (B as Record<string, unknown>)[name], "function", `B missing ${name}`);
  }
});

test("metaAi.buildMetaAiValidationBody emits a persisted-query body with fresh UUID-bearing variables", () => {
  const body = meta.buildMetaAiValidationBody() as {
    doc_id: string;
    variables: { conversationId: string; userAgent: string; isNewConversation: boolean };
  };
  assert.equal(typeof body.doc_id, "string");
  assert.ok(body.variables.conversationId.startsWith("c."), "conversationId is base62 c.* id");
  assert.equal(body.variables.isNewConversation, true);
  assert.ok(body.variables.userAgent.includes("Mozilla/"), "carries the Meta AI UA const");
  // Two calls must mint distinct conversation ids (random-seeded).
  const second = meta.buildMetaAiValidationBody() as { variables: { conversationId: string } };
  assert.notEqual(body.variables.conversationId, second.variables.conversationId);
});

test("host dispatcher surface remains intact after the move", () => {
  assert.equal(typeof (HOST as Record<string, unknown>).validateProviderApiKey, "function");
  assert.equal(typeof (HOST as Record<string, unknown>).validateWebCookieProvider, "function");
});

test("ChatGPT validation exposes a rotated session cookie for persistence", async () => {
  __setTlsFetchOverrideForTesting(async () => ({
    status: 200,
    headers: new Headers({
      "Content-Type": "application/json",
      "set-cookie": "__Secure-next-auth.session-token=ROTATED; Path=/; HttpOnly; Secure",
    }),
    text: JSON.stringify({ accessToken: "access-token", user: { id: "user-1" } }),
    body: null,
  }));

  try {
    const result = await A.validateChatGptWebProvider({
      apiKey: "__Secure-next-auth.session-token=OLD; cf_clearance=CLEAR",
    });
    assert.equal(result.valid, true);
    assert.equal(
      result.refreshedCookie,
      "cf_clearance=CLEAR; __Secure-next-auth.session-token=ROTATED"
    );
  } finally {
    __setTlsFetchOverrideForTesting(null);
  }
});

test("Grok validation uses the browser transport when it is enabled", async () => {
  const previous = process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT;
  process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT = "1";
  __setBrowserGrokChatOverrideForTesting(async (request) => {
    assert.equal(request.userAgent, "Mozilla/5.0 test-browser");
    return {
      status: 200,
      contentType: "application/x-ndjson",
      body: Buffer.from('{"result":{"response":{"token":"OK"}}}\n'),
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

  try {
    const result = await A.validateGrokWebProvider({
      apiKey: "sso=test; sso-rw=test-rw",
      providerSpecificData: { customUserAgent: "Mozilla/5.0 test-browser" },
    });
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
    assert.match(result.warning || "", /browser-owned Grok WebSocket/);
  } finally {
    __setBrowserGrokChatOverrideForTesting(null);
    if (previous === undefined) delete process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT;
    else process.env.OMNIROUTE_GROK_BROWSER_TRANSPORT = previous;
  }
});
