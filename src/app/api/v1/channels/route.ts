import { NextResponse } from "next/server";

import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";
import { getProviderConnections } from "@/lib/db/providers";
import { getProviderTodayMetrics } from "@/lib/db/callLogStats";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { getStats as getAccountSemaphoreStats } from "@omniroute/open-sse/services/accountSemaphore.ts";
import { sanitizeErrorMessage, errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";

export const dynamic = "force-dynamic";

type ChannelStatus = "healthy" | "degraded" | "down";

type ConnectionHealth = {
  id: string;
  isActive?: boolean;
  testStatus?: string | null;
  rateLimitedUntil?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

function isCooling(connection: ConnectionHealth, now: number): boolean {
  const until = connection.rateLimitedUntil
    ? new Date(connection.rateLimitedUntil).getTime()
    : Number.NaN;
  return Number.isFinite(until) && until > now;
}

function isTerminal(connection: ConnectionHealth): boolean {
  return ["expired", "banned", "credits_exhausted"].includes(
    String(connection.testStatus || "").toLowerCase()
  );
}

export function classifyChannelStatus({
  configured,
  active,
  unavailable,
  breakerState,
}: {
  configured: number;
  active: number;
  unavailable: number;
  breakerState?: string | null;
}): ChannelStatus {
  if (configured === 0 || active === 0 || breakerState === "OPEN" || unavailable >= active) {
    return "down";
  }
  if (unavailable > 0 || breakerState === "HALF_OPEN") return "degraded";
  return "healthy";
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request: Request) {
  const apiKey = extractApiKey(request);
  const apiKeyOk = apiKey ? await isValidApiKey(apiKey) : false;
  const dashboardOk = !apiKeyOk ? await isDashboardSessionAuthenticated(request) : false;
  if (!apiKeyOk && !dashboardOk && isRequireApiKeyEnabled()) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required");
  }

  try {
    const [connections, todayMetrics] = await Promise.all([
      getProviderConnections({}, undefined, undefined, [
        "id",
        "provider",
        "is_active",
        "test_status",
        "rate_limited_until",
        "last_error",
        "last_error_at",
      ]),
      Promise.resolve(getProviderTodayMetrics()),
    ]);
    const breakers = new Map(
      getAllCircuitBreakerStatuses().map((breaker) => [breaker.name, breaker])
    );
    const semaphoreStats = getAccountSemaphoreStats();
    const metricByProvider = new Map(todayMetrics.map((metric) => [metric.provider, metric]));
    const now = Date.now();

    const data = Object.keys(WEB_COOKIE_PROVIDERS).map((channel) => {
      const channelConnections = connections.filter(
        (connection) => connection.provider === channel
      ) as ConnectionHealth[];
      const activeConnections = channelConnections.filter((connection) => connection.isActive);
      const unavailableConnections = activeConnections.filter(
        (connection) => isCooling(connection, now) || isTerminal(connection)
      );
      const breaker = breakers.get(channel);
      const metric = metricByProvider.get(channel);
      const queue = activeConnections.reduce(
        (totals, connection) => {
          const stats = semaphoreStats[`${channel}:${connection.id}`];
          return {
            running: totals.running + (stats?.running ?? 0),
            queued: totals.queued + (stats?.queued ?? 0),
          };
        },
        { running: 0, queued: 0 }
      );
      const latestConnectionError = [...channelConnections]
        .filter((connection) => connection.lastError)
        .sort(
          (a, b) => new Date(b.lastErrorAt || 0).getTime() - new Date(a.lastErrorAt || 0).getTime()
        )[0];
      const lastError = latestConnectionError?.lastError || metric?.lastError || null;
      const lastErrorAt = latestConnectionError?.lastErrorAt || metric?.lastErrorAt || null;

      return {
        channel,
        status: classifyChannelStatus({
          configured: channelConnections.length,
          active: activeConnections.length,
          unavailable: unavailableConnections.length,
          breakerState: breaker?.state,
        }),
        today: {
          used: metric?.usedToday ?? 0,
          successful: metric?.successfulToday ?? 0,
          remaining_estimate: null,
          timezone: "UTC",
        },
        accounts: {
          configured: channelConnections.length,
          active: activeConnections.length,
          cooling_or_terminal: unavailableConnections.length,
          running: queue.running,
          queued: queue.queued,
        },
        breaker: {
          state: breaker?.state ?? "CLOSED",
          retry_after_ms: breaker?.retryAfterMs ?? 0,
        },
        last_error: lastError ? sanitizeErrorMessage(lastError) : null,
        last_error_at: lastErrorAt,
      };
    });

    return NextResponse.json(
      {
        object: "list",
        checked_at: new Date(now).toISOString(),
        data,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return errorResponse(HTTP_STATUS.SERVER_ERROR, "Failed to fetch channel health");
  }
}
