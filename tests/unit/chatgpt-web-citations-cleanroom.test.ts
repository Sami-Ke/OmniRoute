import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderChatGptTextWithAnnotations } from "../../open-sse/executors/chatgpt-web/citations.ts";
import { buildChatGptWebOpenAiResponse } from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
import { parseChatGptWebDirectConversation } from "../../open-sse/utils/chatgptWebBrowserSession.ts";

const urlMarker = "\uE200url\uE202Tesla\uE202";
const citationMarker = "\uE200cite\uE202turn0search0\uE202turn0search3\uE201";
const citationMetadata = {
  content_references: [
    {
      type: "webpage",
      title: "Tesla",
      matched_text: urlMarker,
      start_idx: 0,
      end_idx: urlMarker.length,
      safe_urls: ["https://www.tesla.com/en_au/support/autopilot"],
    },
    {
      type: "grouped_webpages",
      matched_text: citationMarker,
      start_idx: 42,
      end_idx: 42 + citationMarker.length,
      items: [
        {
          title: "Tesla FSD v14 release notes",
          url: "https://www.tesla.com/support/fsd-v14?utm_source=chatgpt.com",
          attribution: "tesla.com",
        },
        {
          title: "Owner discussion",
          url: "https://example.com/owners/fsd-v14",
          attribution: "example.com",
        },
      ],
    },
  ],
};
const groupedCitationMetadata = {
  content_references: [citationMetadata.content_references[1]],
};

describe("ChatGPT Web citations preserved on official clean-room transport", () => {
  test("renders private markers as Markdown links and trusted URL annotations", () => {
    const answer = urlMarker + " FSD v14 is rolling out " + citationMarker;
    const rendered = renderChatGptTextWithAnnotations(answer, citationMetadata);

    assert.match(
      rendered.content,
      /\[Tesla\]\(https:\/\/www\.tesla\.com\/en_au\/support\/autopilot\) FSD v14 is rolling out/
    );
    assert.match(
      rendered.content,
      /\[1\]\(https:\/\/www\.tesla\.com\/support\/fsd-v14\?utm_source=chatgpt\.com\)/
    );
    assert.match(rendered.content, /\[2\]\(https:\/\/example\.com\/owners\/fsd-v14\)/);
    assert.doesNotMatch(rendered.content, /[\uE200\uE201\uE202]|turn0search/);
    assert.deepEqual(
      rendered.annotations.map((item) => item.url_citation.url),
      [
        "https://www.tesla.com/en_au/support/autopilot",
        "https://www.tesla.com/support/fsd-v14?utm_source=chatgpt.com",
        "https://example.com/owners/fsd-v14",
      ]
    );
  });

  test("carries only content-reference metadata out of the direct browser stream", () => {
    const message = {
      id: "assistant-message",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["answer"] },
      status: "finished_successfully",
      end_turn: true,
      metadata: citationMetadata,
    };
    const directSse =
      'event: delta_encoding\ndata: "v1"\n\n' +
      "event: delta\ndata: " +
      JSON.stringify({ p: "", o: "add", v: { message } }) +
      "\n\n" +
      'data: {"type":"message_stream_complete","conversation_id":"conversation"}\n\n' +
      "data: [DONE]\n\n";

    const result = parseChatGptWebDirectConversation(directSse);

    assert.equal(result.text, "answer");
    assert.equal(result.conversationId, "conversation");
    assert.deepEqual(result.metadata, citationMetadata);
  });

  test("applies the rendered links to both JSON and streaming OpenAI responses", async () => {
    const result = {
      conversationId: "conversation",
      turnExchangeId: "turn",
      text: "Answer " + citationMarker,
      metadata: groupedCitationMetadata,
      status: "finished_successfully",
      endTurn: true as const,
    };

    const jsonResponse = buildChatGptWebOpenAiResponse("gpt-5-6", result, false, {
      id: "chatcmpl-citations",
      created: 123,
    });
    const json = (await jsonResponse.json()) as {
      choices: Array<{
        message: {
          content: string;
          annotations: Array<{ url_citation: { url: string } }>;
        };
      }>;
    };
    assert.match(
      json.choices[0].message.content,
      /\[1\]\(https:\/\/www\.tesla\.com\/support\/fsd-v14/
    );
    assert.deepEqual(
      json.choices[0].message.annotations.map((item) => item.url_citation.url),
      [
        "https://www.tesla.com/support/fsd-v14?utm_source=chatgpt.com",
        "https://example.com/owners/fsd-v14",
      ]
    );

    const streamResponse = buildChatGptWebOpenAiResponse("gpt-5-6", result, true, {
      id: "chatcmpl-citations",
      created: 123,
    });
    const stream = await streamResponse.text();
    assert.match(stream, /"content":"Answer \[1\]\(https:\/\/www\.tesla\.com\/support\/fsd-v14/);
    assert.match(stream, /"annotations":/);
    assert.ok(stream.endsWith("data: [DONE]\n\n"));
  });
});
