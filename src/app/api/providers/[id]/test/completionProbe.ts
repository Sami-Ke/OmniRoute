/**
 * Real-completion connection probe (mode: "completion").
 *
 * The default connection test validates credentials only. This probe sends one
 * non-streaming completion through the connection being tested so the result
 * also covers provider-side conversation gates such as ChatGPT Sentinel.
 */
import { getProviderCredentials } from "@/sse/services/auth";
import { handleChatCore } from "@omniroute/open-sse/handlers/chatCore.ts";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export const COMPLETION_PROBE_TIMEOUT_MS = 90_000;

const PROBE_PROMPT = "Reply with exactly: OK";
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

/**
 * ChatGPT Web has a registered model that is intended for free, Plus, and Pro
 * tiers. Use it only when the caller and connection did not provide a model;
 * other providers must still opt into a concrete default to avoid guessing
 * which account-specific model is usable.
 */
function resolveProbeModel(
  connection: any,
  requestedModel: string | null | undefined
): string | null {
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (requested) return requested;

  const configured =
    typeof connection?.defaultModel === "string" ? connection.defaultModel.trim() : "";
  if (configured) return configured;

  if (connection?.provider === "chatgpt-web") {
    const entry = getRegistryEntry("chatgpt-web");
    const fallback = entry?.models?.find((candidate) => candidate.id === "gpt-5.5");
    return fallback?.id || null;
  }

  return null;
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

  const model = resolveProbeModel(connection, requestedModel);
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
    result instanceof Response
      ? result
      : result?.response instanceof Response
        ? result.response
        : null;
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
    // Non-JSON body: status still determines whether the probe passed.
  }

  const latencyMs = Date.now() - started;
  if (statusCode >= 200 && statusCode < 300) {
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
