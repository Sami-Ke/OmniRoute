export type UrlCitationAnnotation = {
  type: "url_citation";
  url_citation: {
    url: string;
    title: string;
    start_index: number;
    end_index: number;
  };
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
 * Extract URL annotations from rendered Markdown links and bare URLs.
 * Callers decide which URLs are trusted before exposing the annotations.
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
