import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createProjectSourceReader } from "../src/node-source-reader.js";
import {
  bindMemoryObservation,
  createAnchor,
  gateMemoryObservation,
  resolveSymbol,
} from "../src/sourcetether.js";

const path = "src/physics.ts";
const source = `
export class Physics {
  static gravity = 9.81;
  static unit = "m/s²";
}
`;

const provenance = {
  externalObservationId: "3",
  capturedAt: "2026-08-23T09:05:33.872Z",
  project: "SourceTether",
  memorySessionId: "memory-session-1",
  contentSessionId: "content-session-1",
};

function inMemorySourceReader(sourceText: string) {
  return (projectRelativePath: string) => projectRelativePath === path ? sourceText : undefined;
}

const bindingClock = () => new Date("2026-08-23T10:00:00.000Z");

test("binds an explicit atomic claim to Physics.gravity with Claude-Mem provenance", () => {
  const result = bindMemoryObservation({
    atomicClaim: "Physics.gravity is Earth gravity in m/s².",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);

  assert.equal(result.status, "bound");
  if (result.status === "bound") {
    const independentlyResolved = resolveSymbol(source, path, "Physics.gravity");
    assert.ok(independentlyResolved, "Physics.gravity should resolve independently");
    assert.match(result.observation.id, /^claude-mem-bound:[a-f0-9]{64}$/);
    assert.equal(result.observation.content, "Physics.gravity is Earth gravity in m/s².");
    assert.equal(result.observation.capturedAt, provenance.capturedAt);
    assert.equal(result.observation.boundAt, "2026-08-23T10:00:00.000Z");
    assert.notEqual(result.observation.boundAt, result.observation.provenance.capturedAt);
    assert.deepEqual(result.observation.provenance, provenance);
    assert.deepEqual(result.observation.anchor, createAnchor(independentlyResolved));
    assert.equal(result.symbol.qualifiedName, "Physics.gravity");
  }
});

test("distinct claims bound to one external observation and symbol receive distinct IDs", () => {
  const first = bindMemoryObservation({
    atomicClaim: "Physics.gravity is Earth gravity in m/s².",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);
  const second = bindMemoryObservation({
    atomicClaim: "Physics.gravity is a static property.",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);

  assert.equal(first.status, "bound");
  assert.equal(second.status, "bound");
  if (first.status === "bound" && second.status === "bound") {
    assert.notEqual(first.observation.id, second.observation.id);
  }
});

test("a bound observation is withheld after its selected declaration changes", () => {
  const bound = bindMemoryObservation({
    atomicClaim: "Physics.gravity is Earth gravity in m/s².",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);
  assert.equal(bound.status, "bound");
  if (bound.status !== "bound") return;

  const result = gateMemoryObservation(
    bound.observation,
    inMemorySourceReader(source.replace("9.81", "1.62")),
  );
  assert.deepEqual(result, {
    status: "withheld",
    reason: "fingerprint_changed",
    reread: { projectRelativePath: path, qualifiedName: "Physics.gravity" },
  });
});

test("malformed or unresolved selected source cannot be bound", () => {
  const malformed = `${source}\n}`;
  const malformedResult = bindMemoryObservation({
    atomicClaim: "claim",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(malformed));
  const unresolvedResult = bindMemoryObservation({
    atomicClaim: "claim",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.surfaceGravity",
  }, inMemorySourceReader(source));

  assert.deepEqual(malformedResult, { status: "unbound", reason: "source_unparseable" });
  assert.deepEqual(unresolvedResult, {
    status: "unbound",
    reason: "symbol_unresolved_or_ambiguous",
  });
  assert.equal(resolveSymbol(malformed, path, "Physics.gravity"), null);
});

test("empty claims and invalid provenance cannot be bound", () => {
  const emptyClaim = bindMemoryObservation({
    atomicClaim: "   ",
    provenance,
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);
  const emptyExternalId = bindMemoryObservation({
    atomicClaim: "claim",
    provenance: { ...provenance, externalObservationId: "" },
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);
  const invalidTimestamp = bindMemoryObservation({
    atomicClaim: "claim",
    provenance: { ...provenance, capturedAt: "not-a-timestamp" },
    projectRelativePath: path,
    qualifiedName: "Physics.gravity",
  }, inMemorySourceReader(source), bindingClock);

  assert.deepEqual(emptyClaim, { status: "unbound", reason: "invalid_claim" });
  assert.deepEqual(emptyExternalId, { status: "unbound", reason: "invalid_provenance" });
  assert.deepEqual(invalidTimestamp, { status: "unbound", reason: "invalid_provenance" });
});

test("the Node source reader refuses missing, traversal, and symlink-escape paths", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "sourcetether-reader-"));
  const projectRoot = join(temporaryRoot, "project");
  const outsideFile = join(temporaryRoot, "outside.ts");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "inside.ts"), "export const inside = true;");
  writeFileSync(outsideFile, "export const secret = true;");
  symlinkSync(outsideFile, join(projectRoot, "escape.ts"));

  try {
    const reader = createProjectSourceReader(projectRoot);
    assert.equal(reader("inside.ts"), "export const inside = true;");
    assert.equal(reader("missing.ts"), undefined);
    assert.equal(reader("../outside.ts"), undefined);
    assert.equal(reader(outsideFile), undefined);
    assert.equal(reader("escape.ts"), undefined);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
