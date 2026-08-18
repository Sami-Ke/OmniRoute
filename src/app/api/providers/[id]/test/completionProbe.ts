/**
 * Real-completion connection probe (mode: "completion").
 *
 * The default connection test only validates credentials (e.g. chatgpt-web probes
 * /api/auth/session), which can report "valid" while real conversations are blocked
 * further down the pipeline (Sentinel/Turnstile on the conversation endpoint was the
 * motivating incident). This probe sends one real, non-streaming chat completion
 * through handleChatCore pinned to the connection under test — no pool selection,
 * no account fallback, no retry rotation — so the result reflects what live traffic
 * on THIS connection would actually get.
 */
import { getProviderCredentials } from "@/sse/services/auth";
import { handleChatCore } from "@omniroute/open-sse/handlers/chatCore.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

// One probe = one upstream conversation; bound it so a hung upstream cannot
// occupy the connection-test queue (mirrors OAUTH_TEST_TIMEOUT_MS intent, but
// completions on thinking-capable web providers legitimately take longer).
export const COMPLETION_PROBE_TIMEOUT_MS = 90_000;

const PROBE_PROMPT = "Reply with exactly: OK";
// Small but not tiny: leaves room for providers that spend a few tokens on
// forced reasoning preambles before the visible answer.
const PROBE_MAX_TOKENS = 64;

export type CompletionProbeResult = {
  valid: boolean;
  error: string | null;
  statusCode: number | null;
  model: string | null;
  content: string | null;
  latencyMs: number;
};

type ProbeDeps = {
  getCredentials?: (provider: string, connectionId: string, model: string) => Promise<any>;
  runChat?: (options: any) => Promise<any>;
  timeoutMs?: number;
};

function defaultGetCredentials(provider: string, connectionId: string, model: string) {
  // The operator is explicitly re-testing this connection, so selection must not
  // hide it behind its own cooldown/error state — that state is exactly what the
  // probe is trying to refresh.
  return getProviderCredentials(provider, null, [connectionId], model, {
    forcedConnectionId: connectionId,
    allowSuppressedConnections: true,
    bypassQuotaPolicy: true,
  });
}

function probeFailure(
  error: string,
  latencyMs: number,
  model: string | null,
  statusCode: number | null = null
): CompletionProbeResult {
  return { valid: false, error, statusCode, model, content: null, latencyMs };
}

export async function runCompletionProbe(
  connection: any,
  requestedModel: string | null | undefined,
  deps: ProbeDeps = {}
): Promise<CompletionProbeResult> {
  const {
    getCredentials = defaultGetCredentials,
    runChat = handleChatCore,
    timeoutMs = COMPLETION_PROBE_TIMEOUT_MS,
  } = deps;

  const started = Date.now();
  const provider = typeof connection?.provider === "string" ? connection.provider.trim() : "";
  if (!provider) {
    return probeFailure("Connection provider is invalid", Date.now() - started, null);
  }

  const model =
    (typeof requestedModel === "string" && requestedModel.trim()) ||
    (typeof connection?.defaultModel === "string" && connection.defaultModel.trim()) ||
    null;
  if (!model) {
    return probeFailure(
      "No model to probe — pass completionModel in the request body or set a default model on the connection",
      Date.now() - started,
      null
    );
  }

  let credentials: any = null;
  try {
    credentials = await getCredentials(provider, String(connection.id), model);
  } catch (err: any) {
    return probeFailure(
      `Credential resolution failed: ${sanitizeErrorMessage(err?.message || String(err))}`,
      Date.now() - started,
      model
    );
  }
  if (!credentials) {
    return probeFailure(
      "No usable credentials for this connection (completion probe)",
      Date.now() - started,
      model
    );
  }

  const body = {
    model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    stream: false,
    max_tokens: PROBE_MAX_TOKENS,
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let result: any;
  try {
    result = await Promise.race([
      runChat({
        body,
        modelInfo: { provider, model },
        credentials,
        connectionId: String(connection.id),
        clientRawRequest: null,
        userAgent: null,
        comboName: null,
        skipUpstreamRetry: true,
      }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Completion probe timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (err: any) {
    return probeFailure(
      sanitizeErrorMessage(err?.message || String(err)),
      Date.now() - started,
      model
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const response: Response | null =
    result instanceof Response ? result : result?.response instanceof Response ? result.response : null;
  if (!response) {
    return probeFailure("Completion probe produced no response", Date.now() - started, model);
  }

  const statusCode = response.status;
  let content: string | null = null;
  let upstreamError: string | null = null;
  try {
    const data: any = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    content = typeof rawContent === "string" ? rawContent : null;
    const rawError = data?.error?.message;
    upstreamError = typeof rawError === "string" ? rawError : null;
  } catch {
    // Non-JSON body (unexpected for stream:false) — status alone decides validity.
  }

  const latencyMs = Date.now() - started;
  if (statusCode === 200) {
    return { valid: true, error: null, statusCode, model, content, latencyMs };
  }
  return {
    valid: false,
    error: upstreamError || `Completion probe failed (HTTP ${statusCode})`,
    statusCode,
    model,
    content: null,
    latencyMs,
  };
}
