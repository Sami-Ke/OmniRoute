#!/usr/bin/env node

/**
 * Verify the configured ChatGPT Web provider connection through OmniRoute
 * using an admin token stored in the default macOS Keychain.
 *
 * Security boundary:
 * - The token is read only into memory from Keychain and is never printed or
 *   written to a file, argv, or environment variable.
 * - This performs the provider authentication test endpoint, not a real chat
 *   completion, so it does not intentionally consume model quota.
 */

import { spawnSync } from "node:child_process";

const OMNIROUTE_BASE_URL = "https://sami-omniroute.zeabur.app";
const KEYCHAIN_ACCOUNT = "omniroute-chatgpt-web-monitor";
const KEYCHAIN_SERVICE = "OmniRoute ChatGPT Web Admin Token";
const REQUEST_TIMEOUT_MS = 30_000;

function finish(status, exitCode, details = {}) {
  console.log(
    JSON.stringify({
      status,
      provider: "chatgpt-web",
      checkedAt: new Date().toISOString(),
      ...details,
    })
  );
  process.exitCode = exitCode;
}

function readToken() {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  if (result.error || result.status !== 0) {
    throw new Error("admin token is missing or the macOS Keychain is unavailable");
  }
  const token = String(result.stdout || "").replace(/(?:\r\n|\n|\r)$/, "");
  if (!token.startsWith("oma_")) throw new Error("stored admin token is invalid");
  return token;
}

async function request(path, token, options = {}) {
  const response = await fetch(`${OMNIROUTE_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.method ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep unexpected response bodies out of monitoring output.
  }
  return { response, body };
}

async function main() {
  let token;
  try {
    token = readToken();
  } catch (error) {
    finish("ADMIN_TOKEN_UNAVAILABLE", 2, {
      reason: error instanceof Error ? error.message : "keychain read failed",
    });
    return;
  }

  let providersResult;
  try {
    providersResult = await request("/api/providers", token);
  } catch {
    finish("REMOTE_UNAVAILABLE", 1, { reason: "provider list request failed" });
    return;
  }

  if (providersResult.response.status === 401 || providersResult.response.status === 403) {
    finish("ADMIN_TOKEN_INVALID", 2, { httpStatus: providersResult.response.status });
    return;
  }
  if (!providersResult.response.ok) {
    finish("REMOTE_UNAVAILABLE", 1, { httpStatus: providersResult.response.status });
    return;
  }

  const connections = Array.isArray(providersResult.body?.connections)
    ? providersResult.body.connections.filter(
        (connection) => connection?.provider === "chatgpt-web" && typeof connection?.id === "string"
      )
    : [];

  if (connections.length === 0) {
    finish("CHATGPT_WEB_CONNECTION_MISSING", 1, { connections: 0, valid: 0, failed: 0 });
    return;
  }

  let valid = 0;
  let failed = 0;
  let autoReplaced = 0;
  for (const connection of connections) {
    let testResult;
    try {
      testResult = await request(
        `/api/providers/${encodeURIComponent(connection.id)}/test`,
        token,
        {
          method: "POST",
          body: "{}",
        }
      );
    } catch {
      failed += 1;
      continue;
    }

    if (testResult.response.status === 401 || testResult.response.status === 403) {
      finish("ADMIN_TOKEN_INVALID", 2, {
        httpStatus: testResult.response.status,
        connections: connections.length,
        valid,
        failed,
      });
      return;
    }

    if (testResult.response.ok && testResult.body?.valid === true) {
      valid += 1;
      if (testResult.body?.refreshed === true) autoReplaced += 1;
    } else failed += 1;
  }

  if (failed > 0) {
    finish("CHATGPT_WEB_RETEST_FAILED", 1, {
      connections: connections.length,
      valid,
      failed,
      autoReplaced,
    });
    return;
  }

  finish("CHATGPT_WEB_HEALTHY", 0, {
    connections: connections.length,
    valid,
    failed: 0,
    autoReplaced,
  });
}

try {
  await main();
} catch {
  finish("MONITOR_FAILED", 1, { reason: "unexpected monitor error" });
}
