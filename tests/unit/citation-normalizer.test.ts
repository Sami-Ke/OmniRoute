import test from "node:test";
import assert from "node:assert/strict";

const {
  attachResponseProvenance,
  mergeCitationResults,
  normalizeCitationsFromResponse,
  normalizeOpenAICompatibleChunk,
  normalizeOpenAICompatibleResponse,
} = await import("../../open-sse/translator/citationNormalizer.ts");

function messageOf(value: unknown): Record<string, unknown> {
  const body = value as { choices: Array<{ message: Record<string, unknown> }> };
  return body.choices[0].message;
}

test("Claude content-block citations become OpenAI annotations", () => {
  const rawClaude = {
    content: [
      {
        type: "text",
        text: "Claude answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://docs.example.test/claude",
            title: "Claude source",
          },
        ],
      },
    ],
  };

  const normalized = normalizeOpenAICompatibleResponse(
    { choices: [{ message: { role: "assistant", content: "Claude answer", annotations: [] } }] },
    { citationSources: [rawClaude] }
  );

  assert.deepEqual(messageOf(normalized).annotations, [
    {
      type: "url_citation",
      url_citation: {
        url: "https://docs.example.test/claude",
        title: "Claude source",
      },
    },
  ]);
});

test("Gemini grounding chunks become ordered URL annotations", () => {
  const result = normalizeCitationsFromResponse({
    candidates: [
      {
        content: { parts: [{ text: "Gemini answer" }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://example.test/one", title: "One" } },
            { web: { uri: "https://example.test/two", title: "Two" } },
          ],
        },
      },
    ],
  });

  assert.equal(result.metadata.status, "found");
  assert.deepEqual(
    result.annotations.map((annotation) => annotation.url_citation.url),
    ["https://example.test/one", "https://example.test/two"]
  );
});

test("ChatGPT/Grok output annotations are accepted without scanning answer URLs", () => {
  const result = normalizeCitationsFromResponse({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Read https://prose.example.test directly.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://source.example.test/article",
                  title: "Verified source",
                },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    result.annotations.map((annotation) => annotation.url_citation.url),
    ["https://source.example.test/article"]
  );
  assert.equal(result.metadata.sources_detected, 1);
});

test("Responses-style flattened url_citation annotations preserve offsets", () => {
  const result = normalizeCitationsFromResponse({
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "A grounded answer.",
            annotations: [
              {
                type: "url_citation",
                url: "https://source.example.test/grok-live",
                title: "Live source",
                start_index: 3,
                end_index: 18,
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.annotations, [
    {
      type: "url_citation",
      url_citation: {
        url: "https://source.example.test/grok-live",
        title: "Live source",
        start_index: 3,
        end_index: 18,
      },
    },
  ]);
});

test("OpenAI-compatible flattened message annotations normalize consistently", () => {
  const normalized = normalizeOpenAICompatibleResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Perplexity answer",
          annotations: [
            {
              type: "url_citation",
              url: "https://source.example.test/perplexity-one",
              title: "First source",
              start_index: 0,
              end_index: 0,
            },
            {
              type: "url_citation",
              url: "https://source.example.test/perplexity-two",
              title: "Second source",
              start_index: 0,
              end_index: 0,
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(
    (messageOf(normalized).annotations as Array<{ url_citation: { url: string } }>).map(
      (annotation: { url_citation: { url: string } }) => annotation.url_citation.url
    ),
    ["https://source.example.test/perplexity-one", "https://source.example.test/perplexity-two"]
  );
  assert.equal(
    (normalized as { omniroute: { citations: { status: string } } }).omniroute.citations.status,
    "found"
  );
});

test("Perplexity citations and search_results are merged in first-seen order", () => {
  const result = normalizeCitationsFromResponse({
    citations: ["https://example.test/one", "https://example.test/two"],
    search_results: [
      { url: "https://example.test/two", name: "Duplicate" },
      { url: "https://example.test/three", name: "Three" },
    ],
  });

  assert.deepEqual(
    result.annotations.map((annotation) => annotation.url_citation.url),
    ["https://example.test/one", "https://example.test/two", "https://example.test/three"]
  );
});

test("annotations: [] does not hide citations in the native response", () => {
  const normalized = normalizeOpenAICompatibleResponse(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Answer",
            annotations: [],
          },
        },
      ],
    },
    {
      citationSources: [
        {
          message: {
            citations: [{ url: "https://example.test/native", title: "Native" }],
          },
        },
      ],
    }
  );

  assert.equal(
    messageOf(normalized).annotations[0].url_citation.url,
    "https://example.test/native"
  );
});

test("content arrays are always projected to a pure text string", () => {
  const normalized = normalizeOpenAICompatibleResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "output_text", text: " second" },
            { type: "image_url", image_url: { url: "data:image/png;base64,redacted" } },
          ],
        },
      },
    ],
  });

  assert.equal(messageOf(normalized).content, "first second");
  assert.equal(typeof messageOf(normalized).content, "string");
});

test("invalid and duplicate citations retain diagnostic status without accepting non-http URLs", () => {
  const result = normalizeCitationsFromResponse({
    citations: [
      { url: "https://example.test/valid", title: "Valid" },
      { url: "https://example.test/valid", title: "Duplicate" },
      { url: "ftp://example.test/not-accepted", title: "Invalid protocol" },
    ],
  });

  assert.equal(result.metadata.status, "found");
  assert.equal(result.metadata.invalid_candidates, 1);
  assert.deepEqual(
    result.annotations.map((item) => item.url_citation.title),
    ["Valid"]
  );
});

test("unknown citation shapes do not silently become no citation", () => {
  const result = normalizeCitationsFromResponse({
    citations: [{ citation_id: "opaque-provider-reference", label: "not a URL" }],
  });

  assert.equal(result.annotations.length, 0);
  assert.equal(result.metadata.status, "unsupported_shape");
  assert.ok(result.metadata.unknown_shapes.length > 0);
});

test("no citation metadata is reported as none", () => {
  const result = normalizeCitationsFromResponse({
    choices: [{ message: { role: "assistant", content: "No sources here." } }],
  });

  assert.equal(result.metadata.status, "none");
  assert.deepEqual(result.annotations, []);
});

test("streaming and non-streaming normalization produce the same content and annotations", () => {
  const chunks = [
    { choices: [{ delta: { content: "Answer " } }] },
    {
      choices: [
        {
          delta: {
            content: [{ type: "text", text: "with a source." }],
            citations: [{ url: "https://example.test/source", title: "Source" }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];

  let streamedCitations = normalizeCitationsFromResponse([]);
  const streamedContent = chunks
    .map((chunk) => {
      const normalized = normalizeOpenAICompatibleChunk(chunk);
      streamedCitations = mergeCitationResults(streamedCitations, normalized.citations);
      const choice = (normalized.chunk as { choices: Array<{ delta: { content?: string } }> })
        .choices[0];
      return choice?.delta?.content ?? "";
    })
    .join("");

  const nonStream = normalizeOpenAICompatibleResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Answer with a source.",
          annotations: [],
        },
      },
    ],
    citations: [{ url: "https://example.test/source", title: "Source" }],
  });

  assert.equal(streamedContent, messageOf(nonStream).content);
  assert.deepEqual(streamedCitations.annotations, messageOf(nonStream).annotations);
});

test("response provenance preserves the requested slot and reports the actual fallback", () => {
  const normalized = attachResponseProvenance(
    {
      choices: [{ message: { role: "assistant", content: "Answer" } }],
      omniroute: { citations: { status: "none" } },
    },
    {
      requested_provider: "combo",
      requested_model: "combo/geo-observer",
      upstream_provider: "claude-web",
      upstream_model: "claude-sonnet",
      fallback_used: true,
      fallback_provider: "claude-web",
      fallback_model: "claude-sonnet",
    }
  ) as {
    omniroute: {
      provenance: Record<string, unknown>;
      citations: Record<string, unknown>;
    };
  };

  assert.deepEqual(normalized.omniroute.provenance, {
    requested_provider: "combo",
    requested_model: "combo/geo-observer",
    upstream_provider: "claude-web",
    upstream_model: "claude-sonnet",
    fallback_provider: "claude-web",
    fallback_model: "claude-sonnet",
    fallback_used: true,
  });
  assert.deepEqual(normalized.omniroute.citations, { status: "none" });
});
