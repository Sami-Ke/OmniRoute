type JsonRecord = Record<string, unknown>;

export type CitationStatus = "found" | "none" | "unsupported_shape" | "invalid";

export type NormalizedCitation = {
  type: "url_citation";
  url_citation: {
    url: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  };
};

export type CitationNormalizationMetadata = {
  status: CitationStatus;
  sources_detected: number;
  invalid_candidates: number;
  unknown_shapes: string[];
};

export type CitationNormalizationResult = {
  annotations: NormalizedCitation[];
  metadata: CitationNormalizationMetadata;
};

export type ResponseProvenance = {
  requested_provider?: string | null;
  requested_model?: string | null;
  upstream_provider?: string | null;
  upstream_model?: string | null;
  fallback_used?: boolean;
  fallback_provider?: string | null;
  fallback_model?: string | null;
};

type CitationCollector = {
  annotations: NormalizedCitation[];
  seen: Set<string>;
  invalidCandidates: number;
  unknownShapes: Set<string>;
  recognizedContainers: number;
};

type NormalizeResponseOptions = {
  citationSources?: unknown[];
};

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function addUnknownShape(collector: CitationCollector, path: string): void {
  if (collector.unknownShapes.size < 32) collector.unknownShapes.add(path);
}

function addCitation(
  collector: CitationCollector,
  candidate: JsonRecord,
  path: string,
  urlValue: unknown,
  titleValue?: unknown
): boolean {
  const url = asNonEmptyString(urlValue);
  if (!url || !isHttpUrl(url)) {
    collector.invalidCandidates += 1;
    addUnknownShape(collector, path);
    return false;
  }

  const canonical = canonicalUrl(url);
  if (!collector.seen.has(canonical)) {
    collector.seen.add(canonical);
    const title = asNonEmptyString(titleValue);
    const annotation: NormalizedCitation = {
      type: "url_citation",
      url_citation: { url },
    };
    if (title) annotation.url_citation.title = title;

    for (const key of ["start_index", "startIndex"]) {
      if (typeof candidate[key] === "number" && Number.isFinite(candidate[key])) {
        annotation.url_citation.start_index = candidate[key] as number;
        break;
      }
    }
    for (const key of ["end_index", "endIndex"]) {
      if (typeof candidate[key] === "number" && Number.isFinite(candidate[key])) {
        annotation.url_citation.end_index = candidate[key] as number;
        break;
      }
    }

    collector.annotations.push(annotation);
  }
  return true;
}

function collectCitationCandidate(
  value: unknown,
  collector: CitationCollector,
  path: string
): void {
  if (typeof value === "string") {
    addCitation(collector, {}, path, value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCitationCandidate(item, collector, `${path}[${index}]`));
    return;
  }

  const record = toRecord(value);
  if (!record) {
    collector.invalidCandidates += 1;
    addUnknownShape(collector, path);
    return;
  }

  // OpenAI Responses / Chat Completions wrapper.
  if (record.url_citation !== undefined) {
    const nested = toRecord(record.url_citation);
    if (nested) {
      addCitation(collector, nested, `${path}.url_citation`, nested.url, nested.title);
    } else {
      collector.invalidCandidates += 1;
      addUnknownShape(collector, `${path}.url_citation`);
    }
    return;
  }

  // Gemini grounding chunks and a number of web-search adapters use a `web`
  // object around the actual URL.
  if (record.web !== undefined) {
    const web = toRecord(record.web);
    if (web) {
      addCitation(collector, web, `${path}.web`, web.uri ?? web.url, web.title ?? web.name);
    } else {
      collector.invalidCandidates += 1;
      addUnknownShape(collector, `${path}.web`);
    }
    return;
  }

  const directUrl = record.url ?? record.uri ?? record.link;
  if (directUrl !== undefined) {
    addCitation(collector, record, path, directUrl, record.title ?? record.name);
    return;
  }

  // Some adapters nest a single source under `source` or `citation` while
  // preserving the provider's title at the outer level.
  for (const key of ["source", "citation", "web_result", "webResult"]) {
    if (record[key] !== undefined) {
      collectCitationCandidate(record[key], collector, `${path}.${key}`);
      return;
    }
  }

  collector.invalidCandidates += 1;
  addUnknownShape(collector, path);
}

function collectGroundingMetadata(
  value: unknown,
  collector: CitationCollector,
  path: string
): void {
  const grounding = toRecord(value);
  if (!grounding) {
    collector.invalidCandidates += 1;
    addUnknownShape(collector, path);
    return;
  }

  const chunks = grounding.groundingChunks ?? grounding.grounding_chunks;
  if (chunks === undefined) {
    collector.invalidCandidates += 1;
    addUnknownShape(collector, `${path}.groundingChunks`);
    return;
  }

  collector.recognizedContainers += 1;
  if (!Array.isArray(chunks)) {
    collector.invalidCandidates += 1;
    addUnknownShape(collector, `${path}.groundingChunks`);
    return;
  }
  chunks.forEach((chunk, index) =>
    collectCitationCandidate(chunk, collector, `${path}.groundingChunks[${index}]`)
  );
}

function collectResponseCitations(
  value: unknown,
  collector: CitationCollector,
  path: string,
  visited: Set<object>
): void {
  if (typeof value !== "object" || value === null) return;
  if (visited.has(value as object)) return;
  visited.add(value as object);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectResponseCitations(item, collector, `${path}[${index}]`, visited)
    );
    return;
  }

  const record = toRecord(value);
  if (!record) return;

  if (record.annotations !== undefined) {
    collector.recognizedContainers += 1;
    collectCitationCandidate(record.annotations, collector, `${path}.annotations`);
  }

  if (record.citations !== undefined) {
    collector.recognizedContainers += 1;
    collectCitationCandidate(record.citations, collector, `${path}.citations`);
  }

  if (record.citation !== undefined) {
    collector.recognizedContainers += 1;
    collectCitationCandidate(record.citation, collector, `${path}.citation`);
  }

  for (const key of ["search_results", "searchResults", "web_results", "webResults"]) {
    if (record[key] !== undefined) {
      collector.recognizedContainers += 1;
      collectCitationCandidate(record[key], collector, `${path}.${key}`);
    }
  }

  for (const key of ["groundingMetadata", "grounding_metadata"]) {
    if (record[key] !== undefined) {
      collectGroundingMetadata(record[key], collector, `${path}.${key}`);
    }
  }

  // Restrict traversal to response containers. In particular, do not scan all
  // strings in the answer for URLs: a URL in prose is not provider-verified.
  for (const key of [
    "response",
    "output",
    "output_text",
    "content",
    "message",
    "choices",
    "delta",
    "candidates",
    "parts",
    "data",
    "block",
    "content_block",
    "items",
  ]) {
    if (record[key] !== undefined) {
      collectResponseCitations(record[key], collector, `${path}.${key}`, visited);
    }
  }
}

function finalizeCitationResult(collector: CitationCollector): CitationNormalizationResult {
  const status: CitationStatus =
    collector.annotations.length > 0
      ? "found"
      : collector.unknownShapes.size > 0
        ? "unsupported_shape"
        : collector.invalidCandidates > 0
          ? "invalid"
          : "none";

  return {
    annotations: collector.annotations,
    metadata: {
      status,
      sources_detected: collector.annotations.length,
      invalid_candidates: collector.invalidCandidates,
      unknown_shapes: [...collector.unknownShapes],
    },
  };
}

function createCollector(): CitationCollector {
  return {
    annotations: [],
    seen: new Set(),
    invalidCandidates: 0,
    unknownShapes: new Set(),
    recognizedContainers: 0,
  };
}

export function normalizeCitationCandidates(
  value: unknown,
  path = "$.citations"
): CitationNormalizationResult {
  const collector = createCollector();
  collectCitationCandidate(value, collector, path);
  return finalizeCitationResult(collector);
}

export function normalizeCitationsFromResponse(value: unknown): CitationNormalizationResult {
  const collector = createCollector();
  collectResponseCitations(value, collector, "$", new Set());
  return finalizeCitationResult(collector);
}

export function mergeCitationResults(
  ...results: CitationNormalizationResult[]
): CitationNormalizationResult {
  const collector = createCollector();
  for (const result of results) {
    for (const annotation of result.annotations) {
      const nested = annotation.url_citation;
      addCitation(collector, nested, "$.annotations", nested.url, nested.title);
    }
    collector.invalidCandidates += result.metadata.invalid_candidates;
    for (const shape of result.metadata.unknown_shapes) addUnknownShape(collector, shape);
  }
  return finalizeCitationResult(collector);
}

export function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const record = toRecord(value);
    if (!record) return "";
    if (typeof record.text === "string") return record.text;
    if (typeof record.output_text === "string") return record.output_text;
    if (Array.isArray(record.content)) return normalizeContent(record.content);
    if (Array.isArray(record.parts)) return normalizeContent(record.parts);
    return "";
  }

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const record = toRecord(item);
    if (!record) continue;
    if (typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    if (Array.isArray(record.content)) parts.push(normalizeContent(record.content));
    else if (Array.isArray(record.parts)) parts.push(normalizeContent(record.parts));
  }
  return parts.join("");
}

function mergeExistingCitationMetadata(
  existing: unknown,
  normalized: CitationNormalizationMetadata
): CitationNormalizationMetadata {
  const record = toRecord(existing);
  const existingStatus = record?.status;
  const status: CitationStatus =
    normalized.status !== "none"
      ? normalized.status
      : existingStatus === "found" ||
          existingStatus === "none" ||
          existingStatus === "unsupported_shape" ||
          existingStatus === "invalid"
        ? existingStatus
        : normalized.status;
  const existingShapes = Array.isArray(record?.unknown_shapes)
    ? record.unknown_shapes.filter((item): item is string => typeof item === "string")
    : [];
  const unknownShapes = [...new Set([...existingShapes, ...normalized.unknown_shapes])].slice(
    0,
    32
  );
  const existingDetected =
    typeof record?.sources_detected === "number" && Number.isFinite(record.sources_detected)
      ? record.sources_detected
      : 0;
  const existingInvalid =
    typeof record?.invalid_candidates === "number" && Number.isFinite(record.invalid_candidates)
      ? record.invalid_candidates
      : 0;

  return {
    status,
    sources_detected: Math.max(existingDetected, normalized.sources_detected),
    invalid_candidates: existingInvalid + normalized.invalid_candidates,
    unknown_shapes: unknownShapes,
  };
}

export function normalizeOpenAICompatibleResponse(
  body: unknown,
  options: NormalizeResponseOptions = {}
): unknown {
  const bodyRecord = toRecord(body);
  if (!bodyRecord) return body;

  const citationResults = [
    normalizeCitationsFromResponse(bodyRecord),
    ...(options.citationSources ?? []).map(normalizeCitationsFromResponse),
  ];
  const citations = mergeCitationResults(...citationResults);
  const normalized: JsonRecord = { ...bodyRecord };

  if (Array.isArray(bodyRecord.choices)) {
    normalized.choices = bodyRecord.choices.map((choice) => {
      const choiceRecord = toRecord(choice);
      if (!choiceRecord) return choice;
      const normalizedChoice: JsonRecord = { ...choiceRecord };
      const message = toRecord(choiceRecord.message);
      if (message) {
        const normalizedMessage: JsonRecord = { ...message };
        normalizedMessage.content = normalizeContent(message.content);
        const localCitations = mergeCitationResults(
          normalizeCitationsFromResponse(message),
          ...((options.citationSources ?? []).map(
            normalizeCitationsFromResponse
          ) as CitationNormalizationResult[])
        );
        normalizedMessage.annotations = localCitations.annotations.length
          ? localCitations.annotations
          : citations.annotations;
        normalizedChoice.message = normalizedMessage;
      }
      return normalizedChoice;
    });
  }

  const omniroute = toRecord(bodyRecord.omniroute);
  const existingCitations = omniroute?.citations;
  normalized.omniroute = {
    ...(omniroute ?? {}),
    citations: mergeExistingCitationMetadata(existingCitations, citations.metadata),
  };
  return normalized;
}

export function normalizeOpenAICompatibleChunk(value: unknown): {
  chunk: unknown;
  citations: CitationNormalizationResult;
  changed: boolean;
} {
  const record = toRecord(value);
  if (!record) {
    return { chunk: value, citations: normalizeCitationCandidates([]), changed: false };
  }

  const citations = normalizeCitationsFromResponse(record);
  const normalized: JsonRecord = { ...record };
  let changed = false;
  if (Array.isArray(record.choices)) {
    normalized.choices = record.choices.map((choice) => {
      const choiceRecord = toRecord(choice);
      if (!choiceRecord) return choice;
      const normalizedChoice: JsonRecord = { ...choiceRecord };
      const delta = toRecord(choiceRecord.delta);
      if (delta) {
        const normalizedDelta: JsonRecord = { ...delta };
        if (delta.content !== undefined) {
          normalizedDelta.content = normalizeContent(delta.content);
          if (normalizedDelta.content !== delta.content) changed = true;
        }
        const deltaCitations = normalizeCitationsFromResponse(delta);
        if (deltaCitations.annotations.length > 0 || Array.isArray(delta.annotations)) {
          normalizedDelta.annotations = deltaCitations.annotations;
          if (
            Array.isArray(delta.annotations) &&
            delta.annotations.length !== deltaCitations.annotations.length
          ) {
            changed = true;
          }
          if (
            delta.citations !== undefined ||
            delta.search_results !== undefined ||
            delta.searchResults !== undefined
          ) {
            changed = true;
          }
        }
        for (const key of ["citations", "search_results", "searchResults"] as const) {
          if (normalizedDelta[key] !== undefined) {
            delete normalizedDelta[key];
            changed = true;
          }
        }
        normalizedChoice.delta = normalizedDelta;
      }
      return normalizedChoice;
    });
  }
  return { chunk: normalized, citations, changed };
}

export function attachResponseProvenance(body: unknown, provenance: ResponseProvenance): unknown {
  const bodyRecord = toRecord(body);
  if (!bodyRecord) return body;
  const omniroute = toRecord(bodyRecord.omniroute);
  const existing = toRecord(omniroute?.provenance);

  const value = (key: keyof ResponseProvenance): string | boolean | null | undefined => {
    const incoming = provenance[key];
    if (incoming !== undefined && incoming !== null && incoming !== "") return incoming;
    const prior = existing?.[key];
    return prior as string | boolean | null | undefined;
  };

  const merged: JsonRecord = { ...(existing ?? {}) };
  for (const key of [
    "requested_provider",
    "requested_model",
    "upstream_provider",
    "upstream_model",
    "fallback_provider",
    "fallback_model",
  ] as const) {
    const resolved = value(key);
    if (resolved !== undefined && resolved !== null && resolved !== "") merged[key] = resolved;
  }
  const fallbackUsed = provenance.fallback_used ?? existing?.fallback_used;
  if (fallbackUsed !== undefined) merged.fallback_used = fallbackUsed;

  return {
    ...bodyRecord,
    omniroute: {
      ...(omniroute ?? {}),
      provenance: merged,
    },
  };
}
