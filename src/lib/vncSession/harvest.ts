import WebSocket from "ws";
import type { VncProviderEntry } from "./manifest";

export interface HarvestCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface HarvestResult {
  cookies: HarvestCookie[];
  /** Declared values discovered in localStorage, sessionStorage, or page URLs. */
  localStorage: Record<string, string>;
  /** Values captured from explicitly allowlisted Network headers. */
  network?: Record<string, string>;
  /** Full Cookie header for the provider origin, only when the canonical contract allows it. */
  cookieHeader: string;
  /** Browser UA needed by providers whose anti-bot clearance is UA-bound. */
  userAgent?: string;
  hasCredential: boolean;
}

/**
 * Explicit, local-only output intended for manually filling a Zeabur
 * OmniRoute connection. This type is returned only by the opt-in export
 * endpoint; normal harvesting and validation responses never include values.
 */
export interface ManualCredentialExport {
  providerId: string;
  providerName: string;
  providerUrl: string;
  credentialKind: "cookie" | "token";
  credentialName: string;
  pasteTarget: "apiKey";
  pasteValue: string | null;
  providerSpecificData: Record<string, string>;
  hasCredential: boolean;
  notes: string[];
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

type CdpEventHandler = (params: any) => void;

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>();
  private sessionId: string | null = null;
  private closed = false;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.on("message", (data) => this.onMessage(data));
    this.ws.on("close", () => this.rejectAll(new Error("CDP websocket closed")));
    this.ws.on("error", (error) => this.rejectAll(toError(error, "CDP websocket error")));
  }

  ready(timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      return Promise.reject(new Error("CDP websocket is closed"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = (error: Error) => finish(toError(error, "CDP websocket error"));
      const onAbort = () => {
        this.close();
        finish(new Error("CDP connection aborted"));
      };
      const timer = setTimeout(() => {
        this.close();
        finish(new Error("CDP open timeout"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };

      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      for (const handler of this.eventHandlers.get(message.method) || []) {
        try {
          handler(message.params || {});
        } catch {
          // An observation callback must never break the CDP command channel.
        }
      }
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) {
      pending.reject(new Error(message.error.message || "CDP command failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  on(method: string, handler: CdpEventHandler): () => void {
    const handlers = this.eventHandlers.get(method) || new Set<CdpEventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.eventHandlers.delete(method);
    };
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
    signal?: AbortSignal
  ): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const onAbort = () => finishReject(new Error(`CDP command aborted: ${method}`));
      const timer = setTimeout(
        () => finishReject(new Error(`CDP command timed out: ${method}`)),
        timeoutMs
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: finishReject,
        cleanup,
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        this.ws.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          (error) => {
            if (error) finishReject(toError(error, `Failed to send CDP command: ${method}`));
          }
        );
      } catch (error) {
        finishReject(toError(error, `Failed to send CDP command: ${method}`));
      }
    });
  }

  async attachToPage(targetOrigin: string, signal?: AbortSignal): Promise<void> {
    const { targetInfos } = await this.send("Target.getTargets", {}, undefined, 10_000, signal);
    const page = selectPageTarget(targetInfos || [], targetOrigin);
    const { sessionId } = await this.send(
      "Target.attachToTarget",
      { targetId: page.targetId, flatten: true },
      undefined,
      10_000,
      signal
    );
    this.sessionId = sessionId;
  }

  async getCookies(url: string, signal?: AbortSignal): Promise<any[]> {
    if (!this.sessionId) throw new Error("CDP page target is not attached");
    const result = await this.send(
      "Network.getCookies",
      { urls: [url] },
      this.sessionId,
      10_000,
      signal
    );
    return result.cookies || [];
  }

  async sendToPage(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    signal?: AbortSignal
  ): Promise<any> {
    if (!this.sessionId) throw new Error("CDP page target is not attached");
    return this.send(method, params, this.sessionId, timeoutMs, signal);
  }

  async getDeclaredStorage(
    keys: readonly string[],
    signal?: AbortSignal
  ): Promise<Record<string, string>> {
    if (!this.sessionId) throw new Error("CDP page target is not attached");

    const expression = `(() => {
      const keys = ${JSON.stringify([...keys])};
      const out = {};
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (const key of keys) {
          const value = store.getItem(key);
          if (typeof value === "string" && value.length > 0) out[key] = value;
        }
      }
      const urls = [window.location.href, ...performance.getEntriesByType("resource").map((e) => e.name)];
      for (const raw of urls) {
        try {
          const url = new URL(raw, window.location.href);
          for (const key of keys) {
            const value = url.searchParams.get(key);
            if (value && !out[key]) out[key] = value;
          }
        } catch {}
      }
      return out;
    })()`;

    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      this.sessionId,
      10_000,
      signal
    );
    const value = result?.result?.value;
    return value && typeof value === "object" ? value : {};
  }

  async getUserAgent(signal?: AbortSignal): Promise<string | null> {
    if (!this.sessionId) throw new Error("CDP page target is not attached");

    const result = await this.send(
      "Runtime.evaluate",
      { expression: "navigator.userAgent", returnByValue: true },
      this.sessionId,
      10_000,
      signal
    );
    const value = result?.result?.value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("CDP client closed"));
    try {
      this.ws.close();
    } catch {
      // Best-effort close.
    }
  }
}

/**
 * Long-lived, allowlisted Network observer attached to a browser-login page.
 * It stores only the normalized Bearer value, never the complete request or
 * header map, and is closed when the browser session stops.
 */
export class NetworkCredentialCapture {
  private readonly values: Record<string, string> = {};
  private readonly requestUrls = new Map<string, string>();
  private readonly unregister: Array<() => void> = [];

  constructor(
    private readonly client: CdpClient,
    private readonly allowedOrigins: readonly string[],
    private readonly outputKey: string
  ) {
    this.unregister.push(
      client.on("Network.requestWillBeSent", (params) => {
        const requestId = typeof params.requestId === "string" ? params.requestId : "";
        const url = typeof params.request?.url === "string" ? params.request.url : "";
        if (requestId && url) {
          if (this.requestUrls.size >= 2048) this.requestUrls.clear();
          this.requestUrls.set(requestId, url);
        }
        this.capture(url, params.request?.headers);
      })
    );
    this.unregister.push(
      client.on("Network.requestWillBeSentExtraInfo", (params) => {
        const requestId = typeof params.requestId === "string" ? params.requestId : "";
        this.capture(requestId ? this.requestUrls.get(requestId) || "" : "", params.headers);
      })
    );
    this.unregister.push(
      client.on("Network.webSocketWillSendHandshakeRequest", (params) => {
        this.capture(params.url, params.request?.headers);
      })
    );
  }

  snapshot(): Record<string, string> {
    return { ...this.values };
  }

  close(): void {
    for (const remove of this.unregister.splice(0)) remove();
    this.client.close();
  }

  private capture(rawUrl: string, headers: unknown): void {
    if (!rawUrl || !headers || typeof headers !== "object") return;

    let origin = "";
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return;
    }
    if (!this.allowedOrigins.includes(origin)) return;

    const authorizationEntry = Object.entries(headers as Record<string, unknown>).find(
      ([name]) => name.toLowerCase() === "authorization"
    );
    const authorization = authorizationEntry?.[1];
    if (typeof authorization !== "string") return;

    const match = authorization.trim().match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) this.values[this.outputKey] = match[1].trim();
  }
}

export async function waitForCdpReady(cdpPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const version = await fetchJson(
        `http://127.0.0.1:${cdpPort}/json/version`,
        controller.signal
      );
      if (version?.webSocketDebuggerUrl) return;
      lastError = new Error("CDP endpoint did not return a websocket URL");
    } catch (error) {
      lastError = toError(error, "CDP endpoint is not ready");
    } finally {
      clearTimeout(timer);
    }
    await delay(500);
  }

  throw new Error(`Browser did not become ready: ${lastError?.message || "CDP timeout"}`);
}

export async function startNetworkCredentialCapture(
  cdpPort: number,
  provider: VncProviderEntry,
  timeoutMs = 15_000
): Promise<NetworkCredentialCapture | null> {
  const rule = provider.networkCapture;
  if (!rule?.authorizationOutputKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let client: CdpClient | null = null;

  try {
    const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`, controller.signal);
    const debuggerUrl = version?.webSocketDebuggerUrl;
    if (typeof debuggerUrl !== "string" || !debuggerUrl) {
      throw new Error("No CDP websocket endpoint from browser container");
    }

    client = new CdpClient(rewriteDebuggerUrl(debuggerUrl, cdpPort));
    await client.ready(Math.min(timeoutMs, 15_000), controller.signal);
    await client.attachToPage(new URL(provider.url).origin, controller.signal);

    const capture = new NetworkCredentialCapture(
      client,
      rule.allowedOrigins,
      rule.authorizationOutputKey
    );
    await client.sendToPage("Network.enable", {}, 10_000, controller.signal);
    return capture;
  } catch (error) {
    client?.close();
    if (controller.signal.aborted) {
      throw new Error(`Network credential capture timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function harvestFromContainer(
  cdpPort: number,
  provider: VncProviderEntry,
  timeoutMs = 20_000,
  networkValues: Record<string, string> = {}
): Promise<HarvestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let client: CdpClient | null = null;

  try {
    const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`, controller.signal);
    const debuggerUrl = version?.webSocketDebuggerUrl;
    if (typeof debuggerUrl !== "string" || !debuggerUrl) {
      throw new Error("No CDP websocket endpoint from browser container");
    }

    client = new CdpClient(rewriteDebuggerUrl(debuggerUrl, cdpPort));
    await client.ready(Math.min(timeoutMs, 15_000), controller.signal);

    const origin = new URL(provider.url).origin;
    await client.attachToPage(origin, controller.signal);
    const [cookiesRaw, declaredStorage, userAgent] = await Promise.all([
      client.getCookies(provider.url, controller.signal),
      client.getDeclaredStorage(provider.requirement.storageKeys, controller.signal),
      client.getUserAgent(controller.signal),
    ]);

    const cookies = cookiesRaw
      .filter((cookie: any) => domainMatches(cookie.domain, origin))
      .map((cookie: any) => ({
        name: String(cookie.name || ""),
        value: String(cookie.value || ""),
        domain: String(cookie.domain || ""),
        path: String(cookie.path || "/"),
      }))
      .filter((cookie: HarvestCookie) => cookie.name.length > 0 && cookie.value.length > 0);

    const cookieHeader = provider.requirement.acceptsFullCookieHeader
      ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
      : "";

    const baseResult: HarvestResult = {
      cookies,
      localStorage: declaredStorage,
      network: networkValues,
      cookieHeader,
      userAgent: userAgent || undefined,
      hasCredential: false,
    };
    const credentials = harvestToCredentials(baseResult, provider);
    const hasCredential =
      typeof credentials.apiKey === "string" ||
      Object.values(credentials.providerSpecificData).some(
        (value) => typeof value === "string" && value.length > 0
      );

    return { ...baseResult, hasCredential };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Browser credential harvest timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    client?.close();
  }
}

export function harvestToCredentials(
  harvest: HarvestResult,
  provider: VncProviderEntry
): { providerSpecificData: Record<string, string>; apiKey: string | null } {
  const requirement = provider.requirement;
  const providerSpecificData: Record<string, string> = {};

  for (const key of requirement.storageKeys) {
    if (key === "cookie") continue;
    const value =
      harvest.localStorage[key] ||
      harvest.cookies.find((cookie) => cookie.name === key)?.value ||
      harvest.network?.[key];
    if (value) providerSpecificData[key] = value;
  }

  if (requirement.kind === "token") {
    const tokenValue =
      requirement.storageKeys.map((key) => providerSpecificData[key]).find(Boolean) || null;
    if (tokenValue && requirement.storageKeys.includes("token")) {
      providerSpecificData.token = tokenValue;
    }
    return { providerSpecificData, apiKey: tokenValue };
  }

  if (provider.id === "grok-web" && harvest.userAgent) {
    providerSpecificData.customUserAgent = harvest.userAgent;
  }

  if (
    requirement.acceptsFullCookieHeader &&
    requirement.storageKeys.includes("cookie") &&
    harvest.cookieHeader
  ) {
    providerSpecificData.cookie = harvest.cookieHeader;
  }

  return { providerSpecificData, apiKey: null };
}

/**
 * Build a copy-friendly credential payload without persisting or validating it.
 *
 * The dashboard's web-session form accepts one raw credential in its primary
 * field, so cookie providers export the full Cookie header and token providers
 * export the raw token. T3 needs both a Cookie header and convex-session-id;
 * its executor already accepts the structured single-field form emitted here.
 */
export function buildManualCredentialExport(
  harvest: HarvestResult,
  provider: VncProviderEntry
): ManualCredentialExport {
  const { providerSpecificData, apiKey } = harvestToCredentials(harvest, provider);
  const notes = [provider.requirement.placeholder];
  let pasteValue: string | null = provider.requirement.kind === "token" ? apiKey : null;

  if (provider.id === "t3-web") {
    const parts = [];
    if (providerSpecificData.cookie) {
      parts.push(`cookies=${providerSpecificData.cookie}`);
    }
    if (providerSpecificData.convexSessionId) {
      parts.push(`convexSessionId=${providerSpecificData.convexSessionId}`);
    }
    pasteValue = parts.length > 0 ? parts.join("\n") : null;
    if (!providerSpecificData.convexSessionId) {
      notes.push(
        "convexSessionId was not found; t3.chat requires it in addition to the Cookie header."
      );
    }
  } else if (provider.id === "adobe-firefly") {
    // The Firefly resolver prefers a user IMS JWT. A page Cookie alone may
    // only produce a guest token, so make that limitation visible in the
    // manual handoff instead of presenting it as a confirmed account token.
    const accessToken =
      providerSpecificData.access_token ||
      providerSpecificData.accessToken ||
      providerSpecificData.token;
    pasteValue = accessToken || providerSpecificData.cookie || null;
    if (!accessToken) {
      notes.push(
        "Adobe Firefly currently exposes only a Cookie value here; a user IMS access_token from an Authorization Bearer request is preferred and may still be required."
      );
    }
  } else if (provider.requirement.kind === "cookie") {
    pasteValue = providerSpecificData.cookie || null;
  }

  const networkOutputKey = provider.networkCapture?.authorizationOutputKey;
  if (networkOutputKey && !providerSpecificData[networkOutputKey]) {
    notes.push(
      `No allowlisted Network Authorization value (${networkOutputKey}) was observed. Make the provider request in the browser, then export again.`
    );
  }

  if (provider.id === "grok-web" && providerSpecificData.customUserAgent) {
    notes.push(
      "Keep customUserAgent unchanged in the target OmniRoute connection; Grok Cloudflare clearance is bound to the browser User-Agent."
    );
  }

  if (!pasteValue) {
    notes.push(
      "No allowlisted credential was found. Finish signing in and trigger a provider request, then export again."
    );
  }

  return {
    providerId: provider.id,
    providerName: provider.name,
    providerUrl: provider.url,
    credentialKind: provider.requirement.kind,
    credentialName: provider.requirement.credentialName,
    pasteTarget: "apiKey",
    pasteValue,
    providerSpecificData,
    hasCredential: Boolean(pasteValue),
    notes,
  };
}

export function rewriteDebuggerUrl(debuggerUrl: string, cdpPort: number): string {
  const url = new URL(debuggerUrl);
  url.protocol = "ws:";
  url.hostname = "127.0.0.1";
  url.port = String(cdpPort);
  return url.toString();
}

export function selectPageTarget(
  targetInfos: CdpTargetInfo[],
  targetOrigin: string
): CdpTargetInfo {
  const pages = targetInfos.filter((target) => target.type === "page");
  const matching = pages.find((target) => safeOrigin(target.url) === targetOrigin);
  if (matching) return matching;
  throw new Error(`No browser page is open for ${targetOrigin}`);
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  return response.json();
}

function domainMatches(cookieDomain: string, origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    const domain = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" && error ? error : fallback);
}
