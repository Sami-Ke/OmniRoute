import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeOpenAIResponse } from "../../open-sse/handlers/responseSanitizer.ts";

test("OpenAI sanitizer preserves documented web citation and channel metadata", () => {
  const annotation = {
    type: "url_citation",
    url_citation: {
      url: "https://example.com/source",
      title: "Example source",
      start_index: 0,
      end_index: 0,
    },
  };
  const omniroute = {
    channel: "gemini-web",
    upstream_model: "gemini-3.5-flash",
    account: "pool-1",
    fallback_used: false,
    quality: "ok",
  };

  const sanitized = sanitizeOpenAIResponse({
    model: "gemini-web/gemini-3.5-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Answer with a source.",
          annotations: [annotation],
        },
      },
    ],
    omniroute,
    x_provider_internal: "drop-me",
  }) as Record<string, unknown>;
  const choices = sanitized.choices as Array<{ message: Record<string, unknown> }>;

  assert.deepEqual(choices[0].message.annotations, [annotation]);
  assert.deepEqual(sanitized.omniroute, omniroute);
  assert.equal(sanitized.x_provider_internal, undefined);
});
