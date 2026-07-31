import test from "node:test";
import assert from "node:assert/strict";

const { GeminiWebExecutor, geminiComposerMatchesPrompt } =
  await import("../../open-sse/executors/gemini-web.ts");

function makeStreamGenerateRaw(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `)]}'\n10\n${JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]])}`;
}

test("composer verification accepts Chromium's blank-line innerText representation", () => {
  assert.equal(geminiComposerMatchesPrompt("第一行\n\n第二行", "第一行\n\n\n第二行"), true);
  assert.equal(geminiComposerMatchesPrompt("第一行\n\n\n第二行", "第一行\n\n\n\n\n第二行"), true);
  assert.equal(
    geminiComposerMatchesPrompt("第一行\n\n第二行", "第一行"),
    false,
    "a genuinely truncated composer must still fail verification"
  );
});

test("gemini-web fills and verifies a multiline prompt atomically before submitting", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const prompt =
    "（請以身在美國、慣用繁體中文的一般使用者視角搜尋並回答以下問題。）\n\n" +
    "美國RSMC生殖醫學中心在台灣有諮詢窗口或合作夥伴嗎？";

  let composerValue = "";
  let keyboardTypeCalls = 0;
  let submitCalls = 0;

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => {
        let responseHandler:
          ((response: { url: () => string; text: () => Promise<string> }) => Promise<void>) | null =
          null;

        return {
          on: (
            event: string,
            handler: (response: { url: () => string; text: () => Promise<string> }) => Promise<void>
          ) => {
            if (event === "response") responseHandler = handler;
          },
          goto: async () => {},
          waitForTimeout: async () => {},
          waitForSelector: async () => ({
            click: async () => {},
            fill: async (value: string) => {
              composerValue = value;
            },
            evaluate: async () => composerValue,
          }),
          keyboard: {
            type: async () => {
              keyboardTypeCalls += 1;
            },
            press: async (key: string) => {
              assert.equal(key, "Enter");
              submitCalls += 1;
              if (responseHandler) {
                await responseHandler({
                  url: () =>
                    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
                  text: async () =>
                    makeStreamGenerateRaw(
                      "RSMC 在台灣設有可供聯絡與初步諮詢的管道，以下整理相關資訊。"
                    ),
                });
              }
            },
          },
        };
      },
    }),
    close: async () => {},
  })) as unknown as typeof originalLaunch;

  try {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.5-flash",
      body: { messages: [{ role: "user", content: prompt }], stream: false },
      stream: false,
      credentials: { apiKey: "test-cookie" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(result.response.status, 200);
    assert.equal(composerValue, prompt, "both lines and the blank line must reach the composer");
    assert.equal(keyboardTypeCalls, 0, "keyboard.type must never be used for prompt text");
    assert.equal(submitCalls, 1, "Enter is pressed only after verification succeeds");

    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.match(json.choices[0].message.content, /RSMC/);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});

test("gemini-web returns structured degraded 502 and does not submit when composer verification fails", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const prompt = "第一行指示\n\n第二行真正問題";
  let submitCalls = 0;

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => ({
        on: () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        waitForSelector: async () => ({
          click: async () => {},
          fill: async () => {},
          evaluate: async () => "第一行指示",
        }),
        keyboard: {
          press: async () => {
            submitCalls += 1;
          },
        },
      }),
    }),
    close: async () => {},
  })) as unknown as typeof originalLaunch;

  try {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.5-flash",
      body: { messages: [{ role: "user", content: prompt }], stream: false },
      stream: false,
      credentials: { apiKey: "test-cookie", connectionId: "test-connection" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(result.response.status, 502);
    assert.equal(submitCalls, 0, "a truncated composer must never be submitted");

    const json = (await result.response.json()) as {
      error: { code: string; channel: string };
      omniroute: {
        quality: string;
        channel: string;
        input_expected_length: number;
        input_observed_length: number;
      };
    };
    assert.equal(json.error.code, "GEMINI_PROMPT_MISMATCH");
    assert.equal(json.error.channel, "gemini-web");
    assert.equal(json.omniroute.quality, "degraded");
    assert.equal(json.omniroute.channel, "gemini-web");
    assert.equal(json.omniroute.input_expected_length, prompt.length);
    assert.equal(json.omniroute.input_observed_length, "第一行指示".length);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});
