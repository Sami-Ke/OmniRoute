export type UrlCitationAnnotation = {
  type: "url_citation";
  url_citation: {
    url: string;
    title: string;
    start_index: number;
    end_index: number;
  };
};

export type WebResponseQuality = "ok" | "degraded";

export type WebResponseObservability = {
  channel: string;
  upstream_model: string;
  account: string;
  fallback_used: boolean;
  quality: WebResponseQuality;
};

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/giu;
const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/giu;

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, "");
}

function canonicalUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.searchParams.delete("utm_source");
    return parsed.toString();
  } catch {
    return value;
  }
}

function pushCitation(
  annotations: UrlCitationAnnotation[],
  seen: Set<string>,
  url: string,
  title: string,
  startIndex: number,
  endIndex: number
): void {
  const canonical = canonicalUrl(url);
  if (seen.has(canonical)) return;
  seen.add(canonical);
  annotations.push({
    type: "url_citation",
    url_citation: {
      url,
      title: title.trim() || url,
      start_index: startIndex,
      end_index: endIndex,
    },
  });
}

/**
 * Extract OpenAI Chat Completions compatible URL annotations from the rendered
 * response text. Markdown links are preferred; bare URLs are a safe fallback.
 * URLs are de-duplicated by canonical URL while preserving first appearance.
 */
export function extractUrlCitationsFromContent(content: string): UrlCitationAnnotation[] {
  const annotations: UrlCitationAnnotation[] = [];
  const seen = new Set<string>();
  const markdownUrlSpans: Array<{ start: number; end: number }> = [];

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const full = match[0];
    const title = match[1] ?? "";
    const url = match[2] ?? "";
    const start = match.index ?? 0;
    const end = start + full.length;
    markdownUrlSpans.push({ start, end });
    pushCitation(annotations, seen, url, title, start, end);
  }

  for (const match of content.matchAll(BARE_URL_RE)) {
    const url = trimTrailingUrlPunctuation(match[0]);
    const start = match.index ?? 0;
    const end = start + url.length;
    if (markdownUrlSpans.some((span) => start >= span.start && end <= span.end)) continue;
    pushCitation(annotations, seen, url, url, start, end);
  }

  return annotations;
}

/**
 * Ratio of repeated Unicode code-point shingles in normalized text.
 *
 *   repeated windows / all windows
 * = (window count - unique window count) / window count
 */
export function duplicateWindowRatio(content: string, windowSize = 20): number {
  const normalized = [...content.replace(/\s+/gu, " ").trim()];
  if (windowSize <= 0 || normalized.length < windowSize * 2) return 0;

  const windowCount = normalized.length - windowSize + 1;
  const unique = new Set<string>();
  for (let index = 0; index < windowCount; index += 1) {
    unique.add(normalized.slice(index, index + windowSize).join(""));
  }
  return (windowCount - unique.size) / windowCount;
}

export function classifyWebResponseQuality(
  content: string,
  degradedThreshold = 0.3
): WebResponseQuality {
  return duplicateWindowRatio(content, 20) > degradedThreshold ? "degraded" : "ok";
}

/**
 * Stable, opaque account label suitable for response metadata. It intentionally
 * does not expose connection ids, emails, or cookie material.
 */
export function opaquePoolAccountLabel(connectionId?: string | null): string {
  if (!connectionId) return "pool-unknown";
  let hash = 0x811c9dc5;
  for (let index = 0; index < connectionId.length; index += 1) {
    hash ^= connectionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pool-${(hash >>> 0).toString(36)}`;
}

export function buildWebResponseObservability({
  channel,
  upstreamModel,
  connectionId,
  fallbackUsed = false,
  content,
}: {
  channel: string;
  upstreamModel: string;
  connectionId?: string | null;
  fallbackUsed?: boolean;
  content: string;
}): WebResponseObservability {
  return {
    channel,
    upstream_model: upstreamModel,
    account: opaquePoolAccountLabel(connectionId),
    fallback_used: fallbackUsed,
    quality: classifyWebResponseQuality(content),
  };
}
