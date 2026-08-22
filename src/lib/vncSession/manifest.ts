import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";
import {
  getWebSessionCredentialRequirement,
  type WebSessionCredentialRequirement,
} from "@/shared/providers/webSessionCredentials";

export interface VncProviderEntry {
  /** Provider id stored in provider_connections.provider. */
  id: string;
  /** Dashboard/catalog label. */
  name: string;
  /** Login page opened by the browser container. */
  url: string;
  /** Canonical OmniRoute credential contract for this provider. */
  requirement: Exclude<WebSessionCredentialRequirement, { kind: "none" }>;
  /** Optional, narrowly scoped Network capture for providers that do not expose the token in storage. */
  networkCapture?: VncNetworkCaptureRule;
}

export interface VncNetworkCaptureRule {
  /** Only requests whose URL origin is listed here may contribute a value. */
  allowedOrigins: readonly string[];
  /** Header value is normalized from `Authorization: Bearer <token>`. */
  authorizationOutputKey?: string;
}

const VNC_NETWORK_CAPTURE_RULES: Readonly<Record<string, VncNetworkCaptureRule>> = {
  "copilot-web": {
    allowedOrigins: ["https://copilot.microsoft.com"],
    authorizationOutputKey: "access_token",
  },
  "microsoft-designer-web": {
    allowedOrigins: ["https://designer.microsoft.com"],
    authorizationOutputKey: "access_token",
  },
  promptql: {
    allowedOrigins: ["https://prompt.ql.app"],
    authorizationOutputKey: "jwt",
  },
  "adobe-firefly": {
    allowedOrigins: ["https://firefly-3p.ff.adobe.io"],
    authorizationOutputKey: "access_token",
  },
};

/**
 * Providers whose credentials cannot yet be reconstructed safely from cookies,
 * localStorage/sessionStorage, and declared credential keys alone.
 */
export const VNC_UNSUPPORTED_PROVIDER_REASONS: Readonly<Record<string, string>> = {
  "copilot-m365-web":
    "requires the account-specific Chathub WebSocket path in addition to an access token",
  "inner-ai": "requires the account email in addition to the session token",
};

export function getVncProvider(id: string | null | undefined): VncProviderEntry | null {
  if (!id || VNC_UNSUPPORTED_PROVIDER_REASONS[id]) return null;

  const catalog = WEB_COOKIE_PROVIDERS[id as keyof typeof WEB_COOKIE_PROVIDERS] as
    { id: string; name: string; website?: string } | undefined;
  const requirement = getWebSessionCredentialRequirement(id);

  if (
    !catalog ||
    typeof catalog.website !== "string" ||
    !catalog.website.startsWith("https://") ||
    !requirement ||
    requirement.kind === "none"
  ) {
    return null;
  }

  return {
    id: catalog.id,
    name: catalog.name,
    url: catalog.website,
    requirement,
    networkCapture: VNC_NETWORK_CAPTURE_RULES[id],
  };
}

export function listVncProviders(): VncProviderEntry[] {
  return Object.keys(WEB_COOKIE_PROVIDERS)
    .map((id) => getVncProvider(id))
    .filter((entry): entry is VncProviderEntry => entry !== null);
}

export function isVncProvider(id: string | null | undefined): boolean {
  return getVncProvider(id) !== null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const profileRoot =
  process.env.OMNIROUTE_VNC_PROFILE_DIR ||
  `${process.env.HOME || "/tmp"}/.omniroute/browser-login-profiles`;

export const VNC_CONFIG = {
  /**
   * This feature uses Chromium CDP only. Build docker/vnc-browser/chromium and
   * tag it with this name, or override OMNIROUTE_VNC_IMAGE.
   */
  image: process.env.OMNIROUTE_VNC_IMAGE || "omniroute-vnc-chromium:local",
  containerVncPort: Number(process.env.OMNIROUTE_VNC_CONTAINER_VNC_PORT || 3000),
  containerCdpPort: Number(process.env.OMNIROUTE_VNC_CONTAINER_CDP_PORT || 9223),
  containerProfileDir: process.env.OMNIROUTE_VNC_CONTAINER_PROFILE_DIR || "/config",
  profileDir: profileRoot,
  persistProfiles: envFlag("OMNIROUTE_VNC_PERSIST_PROFILES", false),
  idleTimeoutMs: Number(process.env.OMNIROUTE_VNC_IDLE_MS || 10 * 60 * 1000),
  maxSessionMs: Number(process.env.OMNIROUTE_VNC_MAX_MS || 30 * 60 * 1000),
  maxSessions: Number(process.env.OMNIROUTE_VNC_MAX_SESSIONS || 4),
  dockerBin: process.env.OMNIROUTE_DOCKER_BIN || "docker",
  browserReadyTimeoutMs: Number(process.env.OMNIROUTE_VNC_READY_MS || 45_000),
  harvestTimeoutMs: Number(process.env.OMNIROUTE_VNC_HARVEST_MS || 20_000),
  chromiumArgs:
    process.env.OMNIROUTE_VNC_CHROMIUM_ARGS ||
    "--remote-debugging-port=9222 --no-first-run --no-default-browser-check",
} as const;

export const VNC_ROUTE_PREFIX = "/api/vnc-session";
