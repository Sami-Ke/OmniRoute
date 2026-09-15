/**
 * Pure Z.ai web-session credential parsing.
 *
 * Keep this module free of executor/browser dependencies because provider validation
 * and dashboard code only need to inspect the credential, not execute a chat turn.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function parseCredentialJson(raw: string): JsonRecord | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Extract the localStorage Bearer token, while accepting legacy token= input. */
export function extractZaiToken(rawCredential: string): string {
  const trimmed = rawCredential.trim();
  const json = parseCredentialJson(trimmed);
  if (json) {
    const token = json.token ?? json.accessToken ?? json.access_token;
    return typeof token === "string" ? token.trim() : "";
  }

  const bearer = trimmed.match(/^(?:Authorization:\s*)?Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();

  const normalized = trimmed.startsWith("Cookie:") ? trimmed.slice(7).trim() : trimmed;
  if (!normalized) return "";
  const match = normalized.match(/(?:^|;\s*)token=([^;]+)/);
  if (match) return match[1].trim();
  return normalized.includes(";") || normalized.includes("=") ? "" : normalized;
}
