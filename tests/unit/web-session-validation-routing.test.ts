import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveWebSessionValidationCredential } from "../../src/shared/providers/webSessionCredentials.ts";

const root = path.resolve(import.meta.dirname, "../..");

const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

test("cookie-kind sessions resolve providerSpecificData.cookie for validation", () => {
  assert.equal(
    resolveWebSessionValidationCredential({
      authType: "cookie",
      apiKey: null,
      providerSpecificData: { cookie: "sessionKey=redacted" },
    }),
    "sessionKey=redacted"
  );
});

test("an existing apiKey remains the validation credential", () => {
  assert.equal(
    resolveWebSessionValidationCredential({
      authType: "cookie",
      apiKey: "token-kind-redacted",
      providerSpecificData: { cookie: "stale-cookie-redacted" },
    }),
    "token-kind-redacted"
  );
});

test("browser recovery replaces stale session chunks and preserves Cloudflare cookies", async () => {
  const { mergeBrowserChatGptCookie } =
    await import("../../open-sse/services/chatgptWebBrowserRecovery.ts");
  assert.equal(
    mergeBrowserChatGptCookie("__Secure-next-auth.session-token=OLD; cf_clearance=CLEAR", [
      { name: "__Secure-next-auth.session-token.0", value: "NEW-0" },
      { name: "__Secure-next-auth.session-token.1", value: "NEW-1" },
    ]),
    "cf_clearance=CLEAR; __Secure-next-auth.session-token.0=NEW-0; __Secure-next-auth.session-token.1=NEW-1"
  );
});

test("testSingleConnection validates a cookie-authenticated session from the persisted cookie field", async () => {
  const { createProviderConnection, getProviderConnectionById } =
    await import("../../src/lib/db/providers.ts");
  const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");

  const connection = await createProviderConnection({
    provider: "gemini-web",
    authType: "cookie",
    name: "gemini-web-validation-fixture",
    apiKey: null,
    providerSpecificData: { cookie: "__Secure-1PSID=redacted-session" },
    isActive: true,
    testStatus: "unknown",
  });

  const originalFetch = globalThis.fetch;
  let seenCookie: string | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (String(request.url).includes("gemini.google.com/app")) {
      seenCookie = request.headers.get("cookie");
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof globalThis.fetch;

  try {
    const result = await testSingleConnection(connection.id);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(seenCookie, "__Secure-1PSID=redacted-session");

    const persisted = await getProviderConnectionById(connection.id);
    assert.equal(persisted?.testStatus, "active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ChatGPT Web validation can repair a still-authenticated browser session", async () => {
  const { createProviderConnection, getProviderConnectionById } =
    await import("../../src/lib/db/providers.ts");
  const { __setTlsFetchOverrideForTesting } =
    await import("../../open-sse/services/chatgptTlsClient.ts");
  const { __setChatGptWebBrowserRecoveryOverrideForTesting } =
    await import("../../open-sse/services/chatgptWebBrowserRecovery.ts");
  const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");

  const connection = await createProviderConnection({
    provider: "chatgpt-web",
    authType: "cookie",
    name: "chatgpt-web-browser-recovery-fixture",
    apiKey: null,
    providerSpecificData: { cookie: "__Secure-next-auth.session-token=OLD" },
    isActive: true,
    testStatus: "unknown",
  });

  __setTlsFetchOverrideForTesting(async () => ({
    status: 401,
    headers: new Headers({ "content-type": "application/json" }),
    text: "{}",
    body: null,
  }));
  __setChatGptWebBrowserRecoveryOverrideForTesting(async () => ({
    valid: true,
    refreshedCookie: "cf_clearance=CLEAR; __Secure-next-auth.session-token=NEW",
  }));

  try {
    const result = await testSingleConnection(connection.id);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.refreshed, true);
    const persisted = await getProviderConnectionById(connection.id);
    assert.equal(
      persisted?.providerSpecificData?.cookie,
      "cf_clearance=CLEAR; __Secure-next-auth.session-token=NEW"
    );
    assert.equal(persisted?.testStatus, "active");
  } finally {
    __setTlsFetchOverrideForTesting(null);
    __setChatGptWebBrowserRecoveryOverrideForTesting(null);
  }
});

test("single connection tests route cookie auth through the shared validator", async () => {
  const source = await read("src/app/api/providers/[id]/test/route.ts");
  assert.match(
    source,
    /connection\.authType === "apikey"\s*\|\|\s*connection\.authType === "cookie"/
  );
  assert.match(source, /resolveWebSessionValidationCredential/);
});

test("credential health sweeps include cookie-authenticated sessions", async () => {
  const source = await read("src/lib/credentialHealth/scheduler.ts");
  assert.match(source, /conn\.authType === "cookie"/);
});
