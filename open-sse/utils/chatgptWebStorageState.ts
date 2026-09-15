type JsonRecord = Record<string, unknown>;

const FIRST_PARTY_COOKIE_HOSTS = ["chatgpt.com", "openai.com"] as const;

export interface ChatGptWebStorageCookie extends JsonRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface ChatGptWebStorageOrigin extends JsonRecord {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface ChatGptWebStorageState {
  cookies: ChatGptWebStorageCookie[];
  origins: ChatGptWebStorageOrigin[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFirstPartyHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\./, "");
  return FIRST_PARTY_COOKIE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

function validateCookie(value: unknown): asserts value is ChatGptWebStorageCookie {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.value !== "string" ||
    typeof value.domain !== "string" ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.httpOnly !== "boolean" ||
    typeof value.secure !== "boolean" ||
    !["Strict", "Lax", "None"].includes(String(value.sameSite))
  ) {
    throw new Error("ChatGPT Web browser storage state contains an invalid cookie");
  }
  if (!isFirstPartyHost(value.domain)) {
    throw new Error("ChatGPT Web browser storage state contains a foreign cookie domain");
  }
}

function validateOrigin(value: unknown): asserts value is ChatGptWebStorageOrigin {
  if (!isRecord(value) || typeof value.origin !== "string" || !Array.isArray(value.localStorage)) {
    throw new Error("ChatGPT Web browser storage state contains an invalid origin");
  }
  let url: URL;
  try {
    url = new URL(value.origin);
  } catch {
    throw new Error("ChatGPT Web browser storage state contains an invalid origin");
  }
  if (url.protocol !== "https:" || !isFirstPartyHost(url.hostname)) {
    throw new Error("ChatGPT Web browser storage state contains a foreign origin");
  }
  for (const entry of value.localStorage) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error("ChatGPT Web browser storage state contains invalid local storage");
    }
  }
}

export function normalizeChatGptWebStorageState(value: unknown): ChatGptWebStorageState {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("ChatGPT Web browser storage state is invalid");
  }
  for (const cookie of value.cookies) validateCookie(cookie);
  for (const origin of value.origins) validateOrigin(origin);
  return structuredClone(value) as unknown as ChatGptWebStorageState;
}
