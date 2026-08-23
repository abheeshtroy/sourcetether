export interface ClaudeMemObservation {
  id: string;
  content: string;
  capturedAt: string;
  project?: string;
  memorySessionId?: string;
  contentSessionId?: string;
}

export type ClaudeMemRetrievalResult =
  | { status: "found"; observation: ClaudeMemObservation }
  | {
      status: "unavailable";
      reason: "not_found" | "worker_unavailable" | "invalid_response" | "request_failed";
    };

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchImplementation = (
  input: string,
  init?: { method?: string },
) => Promise<FetchResponse>;

/**
 * Retrieves one Claude-Mem observation through its documented local worker API.
 * This adapter intentionally returns external data only; source binding remains a
 * separate SourceTether step.
 */
export async function fetchClaudeMemObservationById(
  baseUrl: string,
  observationId: string | number,
  fetchImpl: FetchImplementation = fetch,
): Promise<ClaudeMemRetrievalResult> {
  let requestUrl: string;
  try {
    requestUrl = observationUrl(baseUrl, observationId);
  } catch {
    return { status: "unavailable", reason: "request_failed" };
  }

  let response: FetchResponse;
  try {
    response = await fetchImpl(requestUrl, { method: "GET" });
  } catch {
    return { status: "unavailable", reason: "worker_unavailable" };
  }

  if (response.status === 404) {
    return { status: "unavailable", reason: "not_found" };
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return { status: "unavailable", reason: "worker_unavailable" };
  }
  if (!response.ok) {
    return { status: "unavailable", reason: "request_failed" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", reason: "invalid_response" };
  }

  const observation = normalizeObservation(payload, observationId);
  return observation === null
    ? { status: "unavailable", reason: "invalid_response" }
    : { status: "found", observation };
}

function observationUrl(baseUrl: string, observationId: string | number): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  base.pathname = `${basePath}/api/observation/${encodeURIComponent(String(observationId))}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function normalizeObservation(
  payload: unknown,
  requestedId: string | number,
): ClaudeMemObservation | null {
  if (!isRecord(payload)) return null;

  const id = opaqueId(payload.id);
  if (id === undefined || id !== String(requestedId)) return null;

  const createdAtEpoch = payload.created_at_epoch;
  if (typeof createdAtEpoch !== "number" || !Number.isFinite(createdAtEpoch)) return null;
  let capturedAt: string;
  try {
    capturedAt = new Date(createdAtEpoch).toISOString();
  } catch {
    return null;
  }

  const content = [payload.title, payload.subtitle, payload.narrative, payload.text]
    .map(nonEmptyString)
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
  if (content.length === 0) return null;

  return {
    id,
    content,
    capturedAt,
    ...optionalField("project", payload.project),
    ...optionalField("memorySessionId", payload.memory_session_id),
    ...optionalField("contentSessionId", payload.content_session_id),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function opaqueId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}

function optionalField(name: string, value: unknown): Record<string, string> {
  const normalized = nonEmptyString(value);
  return normalized === undefined ? {} : { [name]: normalized };
}
