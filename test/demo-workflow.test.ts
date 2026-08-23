import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudeMemObservation } from "../src/claude-mem.js";
import {
  DEMO_ATOMIC_CLAIM,
  demoProvenanceFromClaudeMem,
  loadCapturedMemory,
  persistCapturedMemory,
} from "../src/demo-workflow.js";
import { createAnchor, resolveSymbol, type MemoryObservation } from "../src/sourcetether.js";

const source = `export class DescentModel { static gravity = 9.81; }`;
const symbol = resolveSymbol(source, "src/descent-model.ts", "DescentModel.gravity");
assert.ok(symbol);

const observation: MemoryObservation = {
  id: "claude-mem-bound:test",
  content: DEMO_ATOMIC_CLAIM,
  capturedAt: "2026-08-23T12:00:00.000Z",
  boundAt: "2026-08-23T12:05:00.000Z",
  source: "claude-mem",
  provenance: {
    externalObservationId: "3",
    capturedAt: "2026-08-23T12:00:00.000Z",
    project: "SourceTether",
    memorySessionId: "memory-session",
  },
  anchor: createAnchor(symbol),
};

test("demo workflow preserves external provenance while storing the deliberately narrow claim", () => {
  const external: ClaudeMemObservation = {
    id: "3",
    content: "A broader worker observation that is not stored as the selected claim.",
    capturedAt: "2026-08-23T12:00:00.000Z",
    project: "SourceTether",
    memorySessionId: "memory-session",
    contentSessionId: "content-session",
  };

  assert.deepEqual(demoProvenanceFromClaudeMem(external), {
    externalObservationId: "3",
    capturedAt: "2026-08-23T12:00:00.000Z",
    project: "SourceTether",
    memorySessionId: "memory-session",
    contentSessionId: "content-session",
  });
  assert.equal(observation.content, DEMO_ATOMIC_CLAIM);
  assert.notEqual(observation.content, external.content);
});

test("demo workflow serializes and loads one valid captured memory through injected persistence", () => {
  let stored = "";
  persistCapturedMemory(observation, (serialized) => {
    stored = serialized;
  });

  assert.deepEqual(loadCapturedMemory(() => stored), {
    status: "loaded",
    observation,
  });
});

test("demo workflow rejects missing or malformed persisted capture state", () => {
  assert.deepEqual(loadCapturedMemory(() => {
    throw new Error("missing");
  }), { status: "missing_or_malformed" });
  assert.deepEqual(loadCapturedMemory(() => "not json"), { status: "missing_or_malformed" });
  assert.deepEqual(loadCapturedMemory(() => JSON.stringify({ id: "partial" })), {
    status: "missing_or_malformed",
  });
});
