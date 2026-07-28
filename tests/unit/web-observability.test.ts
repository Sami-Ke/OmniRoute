import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWebResponseObservability,
  classifyWebResponseQuality,
  duplicateWindowRatio,
  extractUrlCitationsFromContent,
  opaquePoolAccountLabel,
} from "../../open-sse/services/webObservability.ts";

test("extractUrlCitationsFromContent preserves order, positions, and de-duplicates URLs", () => {
  const content =
    "See [First source](https://example.com/a?utm_source=chatgpt.com) and " +
    "[duplicate](https://example.com/a), then https://example.org/b.";

  const annotations = extractUrlCitationsFromContent(content);
  assert.equal(annotations.length, 2);
  assert.deepEqual(
    annotations.map((item) => ({
      url: item.url_citation.url,
      title: item.url_citation.title,
      text: content.slice(item.url_citation.start_index, item.url_citation.end_index),
    })),
    [
      {
        url: "https://example.com/a?utm_source=chatgpt.com",
        title: "First source",
        text: "[First source](https://example.com/a?utm_source=chatgpt.com)",
      },
      {
        url: "https://example.org/b",
        title: "https://example.org/b",
        text: "https://example.org/b",
      },
    ]
  );
});

test("duplicateWindowRatio detects repeated cumulative snapshots", () => {
  const unique = "台灣黃金條塊可以依照品牌、純度、回購條件與實體門市位置進行比較。";
  const repeated = `${unique}${unique}${unique}${unique}`;

  assert.equal(duplicateWindowRatio("short text"), 0);
  assert.ok(duplicateWindowRatio(unique) < 0.1);
  assert.ok(duplicateWindowRatio(repeated) > 0.3);
  assert.equal(classifyWebResponseQuality(repeated), "degraded");
  assert.equal(classifyWebResponseQuality(unique), "ok");
});

test("opaquePoolAccountLabel is stable without leaking the connection id", () => {
  const connectionId = "connection-secret-123";
  const label = opaquePoolAccountLabel(connectionId);
  assert.equal(label, opaquePoolAccountLabel(connectionId));
  assert.match(label, /^pool-[a-z0-9]+$/);
  assert.doesNotMatch(label, /connection|secret|123/);
});

test("buildWebResponseObservability returns the documented response contract", () => {
  assert.deepEqual(
    buildWebResponseObservability({
      channel: "gemini-web",
      upstreamModel: "gemini-3.5-flash",
      connectionId: "account-two",
      content: "A normal response with enough unique characters to stay healthy.",
    }),
    {
      channel: "gemini-web",
      upstream_model: "gemini-3.5-flash",
      account: opaquePoolAccountLabel("account-two"),
      fallback_used: false,
      quality: "ok",
    }
  );
});
