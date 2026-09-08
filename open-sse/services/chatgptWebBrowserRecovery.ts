/**
 * Browser-backed recovery for ChatGPT Web session cookies.
 *
 * The normal validator uses the TLS client. When that path fails, a fresh
 * Playwright context can replay the same signed-in session through ChatGPT's
 * own browser surface and capture any cookie rotation. The context is
 * deliberately ephemeral: it never creates a second long-lived browser
 * profile or stores a password.
 */

import { randomUUID } from "node:crypto";
import { acquireBrowserContext, openPage, releaseBrowserContext } from "./browserPool.ts";
import { buildSessionCookieHeader, SESSION_TOKEN_FAMILY_RE } from "../utils/nextAuthCookie.ts";

const CHATGPT_HOME_URL = "https://chatgpt.com/";
const CHATGPT_SESSION_PATH = "/api/auth/session";
const RECOVERY_TIMEOUT_MS = 60_000;

export interface ChatGptWebBrowserRecoveryResult {
  valid: boolean;
  refreshedCookie?: string;
  reason?: "browser_unavailable" | "login_required" | "upstream_unavailable" | "invalid_cookie";
}

type BrowserRecoveryOverride = (cookieString: string) => Promise<ChatGptWebBrowserRecoveryResult>;

let testOverride: BrowserRecoveryOverride | null = null;
let pendingRecovery: Promise<ChatGptWebBrowserRecoveryResult> | null = null;

/** Test-only injection point; production uses the real browser path. */
export function __setChatGptWebBrowserRecoveryOverrideForTesting(
  fn: BrowserRecoveryOverride | null
): void {
  testOverride = fn;
}

function parseCookiePairs(rawCookie: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs;
}

function cookieMapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, value] of left) {
    if (right.get(name) !== value) return false;
  }
  return true;
}

/**
 * Preserve the original Cloudflare/device cookies while replacing every
 * NextAuth session-token family member with the browser's current family.
 */
export function mergeBrowserChatGptCookie(
  originalCookie: string,
  browserCookies: Array<{ name: string; value: string }>
): string | null {
  const original = parseCookiePairs(buildSessionCookieHeader(originalCookie));
  const browser = new Map(
    browserCookies
      .filter((cookie) => cookie.name && cookie.value)
      .map((cookie) => [cookie.name, cookie.value])
  );
  const hasSessionCookie = [...browser.keys()].some((name) => SESSION_TOKEN_FAMILY_RE.test(name));
  if (!hasSessionCookie) return null;

  for (const name of original.keys()) {
    if (SESSION_TOKEN_FAMILY_RE.test(name)) original.delete(name);
  }
  for (const [name, value] of browser) original.set(name, value);
  return [...original].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function recoverWithBrowser(cookieString: string): Promise<ChatGptWebBrowserRecoveryResult> {
  const contextKey = `chatgpt-web-recovery:${randomUUID()}`;
  let pooled: Awaited<ReturnType<typeof acquireBrowserContext>> | null = null;

  try {
    pooled = await acquireBrowserContext(contextKey, {
      cookieDomain: ".chatgpt.com",
      cookieString: buildSessionCookieHeader(cookieString),
      warmupUrl: CHATGPT_HOME_URL,
      locale: "en-US",
      timezone: "Asia/Taipei",
    });
    const page = pooled.warmupPage || (await openPage(pooled));

    await page.goto(CHATGPT_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: RECOVERY_TIMEOUT_MS,
    });

    const session = await page.evaluate(async (sessionPath) => {
      try {
        const response = await fetch(sessionPath, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        const contentType = response.headers.get("content-type") || "";
        let data: { accessToken?: string } = {};
        if (contentType.includes("json")) {
          try {
            data = (await response.json()) as { accessToken?: string };
          } catch {
            data = {};
          }
        }
        return {
          status: response.status,
          json: contentType.includes("json"),
          authenticated: Boolean(data.accessToken),
        };
      } catch {
        return { status: 0, json: false, authenticated: false };
      }
    }, CHATGPT_SESSION_PATH);

    const browserCookies = await pooled.context.cookies(CHATGPT_HOME_URL);
    const refreshedCookie = mergeBrowserChatGptCookie(cookieString, browserCookies);

    if (session.authenticated && refreshedCookie) {
      const originalPairs = parseCookiePairs(buildSessionCookieHeader(cookieString));
      const refreshedPairs = parseCookiePairs(refreshedCookie);
      return {
        valid: true,
        ...(cookieMapsEqual(originalPairs, refreshedPairs) ? {} : { refreshedCookie }),
      };
    }
    if (session.status >= 500 || session.status === 0) {
      return { valid: false, reason: "upstream_unavailable" };
    }
    if (session.status === 401 || session.status === 403 || !session.json) {
      return { valid: false, reason: "login_required" };
    }
    return { valid: false, reason: "invalid_cookie" };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("playwright") || message.includes("browser")) {
      return { valid: false, reason: "browser_unavailable" };
    }
    return { valid: false, reason: "upstream_unavailable" };
  } finally {
    // releaseBrowserContext closes the pooled context and the browser when it
    // becomes idle. The page handle is intentionally not returned.
    await releaseBrowserContext(contextKey).catch(() => {});
  }
}

/**
 * Try one browser-owned session recovery at a time. This protects the
 * provider from concurrent nightly checks and request-triggered retries.
 */
export async function recoverChatGptWebSession(
  cookieString: string
): Promise<ChatGptWebBrowserRecoveryResult> {
  if (testOverride) return testOverride(cookieString);
  if (pendingRecovery) return pendingRecovery;
  pendingRecovery = recoverWithBrowser(cookieString).finally(() => {
    pendingRecovery = null;
  });
  return pendingRecovery;
}
