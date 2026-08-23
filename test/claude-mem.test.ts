import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchClaudeMemObservationById,
  type FetchImplementation,
  type FetchResponse,
} from "../src/claude-mem.js";

function response(status: number, payload: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("normalizes a documented Claude-Mem observation response", async () => {
  let requestedUrl = "";
  const fetchImpl: FetchImplementation = async (url, init) => {
    requestedUrl = url;
    assert.deepEqual(init, { method: "GET" });
    return response(200, {
      id: 42,
      title: "SourceTether retrieval gate",
      subtitle: "Safe memory release",
      narrative: "The gate withholds changed anchors.",
      text: "Additional worker text.",
      created_at_epoch: 1_725_000_000_000,
      project: "SourceTether",
      memory_session_id: "memory-session-1",
      content_session_id: "content-session-1",
    });
  };

  const result = await fetchClaudeMemObservationById(
    "http://127.0.0.1:37701/",
    42,
    fetchImpl,
  );

  assert.equal(requestedUrl, "http://127.0.0.1:37701/api/observation/42");
  assert.deepEqual(result, {
    status: "found",
    observation: {
      id: "42",
      content: [
        "SourceTether retrieval gate",
        "Safe memory release",
        "The gate withholds changed anchors.",
        "Additional worker text.",
      ].join("\n\n"),
      capturedAt: "2024-08-30T06:40:00.000Z",
      project: "SourceTether",
      memorySessionId: "memory-session-1",
      contentSessionId: "content-session-1",
    },
  });
});

test("returns not_found for a missing observation", async () => {
  const result = await fetchClaudeMemObservationById(
    "http://worker.example",
    "missing-id",
    async () => response(404, null),
  );

  assert.deepEqual(result, { status: "unavailable", reason: "not_found" });
});

test("returns worker_unavailable when fetch cannot reach the worker", async () => {
  const result = await fetchClaudeMemObservationById(
    "http://worker.example",
    7,
    async () => { throw new TypeError("connection refused"); },
  );

  assert.deepEqual(result, { status: "unavailable", reason: "worker_unavailable" });
});

test("returns invalid_response for malformed JSON or missing required fields", async () => {
  const invalidJson: FetchImplementation = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError("invalid JSON"); },
  });
  const missingContent: FetchImplementation = async () => response(200, {
    id: "8",
    created_at_epoch: 1_725_000_000_000,
  });

  assert.deepEqual(
    await fetchClaudeMemObservationById("http://worker.example", "8", invalidJson),
    { status: "unavailable", reason: "invalid_response" },
  );
  assert.deepEqual(
    await fetchClaudeMemObservationById("http://worker.example", "8", missingContent),
    { status: "unavailable", reason: "invalid_response" },
  );
});

test("allows missing optional project and session metadata", async () => {
  const result = await fetchClaudeMemObservationById(
    "http://worker.example/base",
    "external-9",
    async () => response(200, {
      id: "external-9",
      narrative: "Observation without optional metadata.",
      created_at_epoch: 1_725_000_000_000,
    }),
  );

  assert.deepEqual(result, {
    status: "found",
    observation: {
      id: "external-9",
      content: "Observation without optional metadata.",
      capturedAt: "2024-08-30T06:40:00.000Z",
    },
  });
});

test("returns request_failed for a non-availability HTTP error", async () => {
  const result = await fetchClaudeMemObservationById(
    "http://worker.example",
    1,
    async () => response(500, null),
  );

  assert.deepEqual(result, { status: "unavailable", reason: "request_failed" });
});
