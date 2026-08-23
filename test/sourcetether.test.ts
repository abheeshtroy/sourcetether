import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnchor,
  gateMemoryObservation,
  type MemoryObservation,
  resolveClassStaticProperty,
  resolveSymbol,
  verifyAnchor,
} from "../src/sourcetether.js";

const path = "src/physics.ts";
const baseSource = `
export class Physics {
  static gravity = 9.81;
  static unit = "m/s²";
}
`;

function gravityAnchor() {
  const symbol = resolveClassStaticProperty(baseSource, path, "Physics.gravity");
  assert.ok(symbol, "Physics.gravity should resolve");
  return createAnchor(symbol);
}

function gravityObservation(): MemoryObservation {
  return {
    id: "claude-mem-observation-1",
    content: "Physics.gravity is Earth gravity in m/s².",
    capturedAt: "2026-08-23T00:00:00.000Z",
    boundAt: "2026-08-23T00:01:00.000Z",
    source: "claude-mem",
    provenance: {
      externalObservationId: "claude-mem-observation-1",
      capturedAt: "2026-08-23T00:00:00.000Z",
    },
    anchor: gravityAnchor(),
  };
}

function inMemorySourceReader(sourceText: string) {
  return (projectRelativePath: string) => projectRelativePath === path ? sourceText : undefined;
}

test("Physics.gravity resolves and anchors successfully", () => {
  const symbol = resolveClassStaticProperty(baseSource, path, "Physics.gravity");

  assert.deepEqual(symbol && {
    qualifiedName: symbol.qualifiedName,
    declarationKind: symbol.declarationKind,
    projectRelativePath: symbol.projectRelativePath,
    declarationText: baseSource.slice(symbol.declarationStart, symbol.declarationEnd),
    fingerprintLength: symbol.fingerprint.length,
  }, {
    qualifiedName: "Physics.gravity",
    declarationKind: "class_static_property",
    projectRelativePath: path,
    declarationText: "static gravity = 9.81;",
    fingerprintLength: 64,
  });
  assert.equal(verifyAnchor(gravityAnchor(), baseSource).status, "verified");
});

test("comment and whitespace-only edits remain verified", () => {
  const edited = `
export class Physics {
  static /* measured near sea level */   gravity /* SI units */ =  9.81 ;
  static unit = "m/s²";
}
`;

  assert.equal(verifyAnchor(gravityAnchor(), edited).status, "verified");
});

test("changing gravity's initializer needs revalidation", () => {
  const changed = baseSource.replace("9.81", "1.62");

  assert.equal(
    verifyAnchor(gravityAnchor(), changed).status,
    "needs_revalidation",
  );
});

test("an ASI-sensitive change in gravity's initializer needs revalidation", () => {
  const before = `export class Physics {
  static gravity = () => { return 9.81; };
}`;
  const after = `export class Physics {
  static gravity = () => { return\n9.81; };
}`;
  const symbol = resolveClassStaticProperty(before, path, "Physics.gravity");
  assert.ok(symbol, "Physics.gravity should resolve");
  const changedSymbol = resolveClassStaticProperty(after, path, "Physics.gravity");
  assert.ok(changedSymbol, "changed Physics.gravity should resolve");

  assert.notEqual(symbol.fingerprint, changedSymbol.fingerprint);
  assert.deepEqual(verifyAnchor(createAnchor(symbol), after), {
    status: "needs_revalidation",
    reason: "fingerprint_changed",
    symbol: changedSymbol,
  });
});

test("malformed current source needs revalidation", () => {
  const malformed = `${baseSource}\n}`;

  assert.deepEqual(verifyAnchor(gravityAnchor(), malformed), {
    status: "needs_revalidation",
    reason: "source_unparseable",
  });
});

test("renaming or removing gravity orphans the anchor", () => {
  const renamed = baseSource.replace("gravity", "surfaceGravity");
  const removed = `export class Physics { static unit = "m/s²"; }`;
  const anchor = gravityAnchor();

  assert.equal(verifyAnchor(anchor, renamed).status, "orphaned");
  assert.equal(verifyAnchor(anchor, removed).status, "orphaned");
});

test("an unrelated property change leaves the gravity anchor verified", () => {
  const changed = baseSource.replace('"m/s²"', '"meters per second squared"');

  assert.equal(verifyAnchor(gravityAnchor(), changed).status, "verified");
});

test("the retrieval gate releases a verified anchored memory with its content", () => {
  const observation = gravityObservation();
  const result = gateMemoryObservation(observation, inMemorySourceReader(baseSource));

  assert.equal(result.status, "released");
  if (result.status === "released") {
    assert.equal(result.observation, observation);
    assert.equal(result.observation.content, observation.content);
    assert.equal(result.symbol.qualifiedName, "Physics.gravity");
  }
});

test("the retrieval gate withholds changed gravity without exposing memory content", () => {
  const result = gateMemoryObservation(
    gravityObservation(),
    inMemorySourceReader(baseSource.replace("9.81", "1.62")),
  );

  assert.deepEqual(result, {
    status: "withheld",
    reason: "fingerprint_changed",
    reread: { projectRelativePath: path, qualifiedName: "Physics.gravity" },
  });
  assert.equal("observation" in result, false);
  assert.equal("content" in result, false);
});

test("the retrieval gate withholds an orphaned symbol", () => {
  const result = gateMemoryObservation(
    gravityObservation(),
    inMemorySourceReader(baseSource.replace("gravity", "surfaceGravity")),
  );

  assert.equal(result.status, "withheld");
  assert.equal(result.reason, "orphaned");
});

test("the retrieval gate withholds unparseable source", () => {
  const result = gateMemoryObservation(
    gravityObservation(),
    inMemorySourceReader(`${baseSource}\n}`),
  );

  assert.equal(result.status, "withheld");
  assert.equal(result.reason, "source_unparseable");
});

test("the retrieval gate releases after an unrelated declaration change", () => {
  const result = gateMemoryObservation(
    gravityObservation(),
    inMemorySourceReader(baseSource.replace('"m/s²"', '"meters per second squared"')),
  );

  assert.equal(result.status, "released");
});

test("the retrieval gate withholds an unreadable source with a distinct reason", () => {
  const result = gateMemoryObservation(gravityObservation(), () => undefined);

  assert.deepEqual(result, {
    status: "withheld",
    reason: "source_unreadable",
    reread: { projectRelativePath: path, qualifiedName: "Physics.gravity" },
  });
});

const observationSource = `
interface Anchor {
  qualifiedName: string;
  fingerprint: string;
}

type VerificationResult = "verified" | "needs_revalidation" | "orphaned";

function createAnchor(symbol: string): Anchor {
  return { qualifiedName: symbol, fingerprint: symbol };
}

function verifyAnchor(anchor: Anchor): VerificationResult {
  return anchor.fingerprint ? "verified" : "orphaned";
}

const observationCount = 1;

class MemorySession {
  active = true;
}

class Physics {
  static gravity = 9.81;
}
`;

test("normal TypeScript declarations resolve, anchor, and verify", () => {
  const expectedKinds = {
    Anchor: "interface",
    VerificationResult: "type_alias",
    createAnchor: "function",
    observationCount: "variable",
    MemorySession: "class",
    "Physics.gravity": "class_static_property",
  } as const;

  for (const [name, declarationKind] of Object.entries(expectedKinds)) {
    const symbol = resolveSymbol(observationSource, "src/memory.ts", name);
    assert.ok(symbol, `${name} should resolve`);
    assert.equal(symbol.declarationKind, declarationKind);
    assert.equal(verifyAnchor(createAnchor(symbol), observationSource).status, "verified");
  }
});

test("variable keyword and statement modifier changes need revalidation", () => {
  const constSource = "const value = 1;";
  const constSymbol = resolveSymbol(constSource, "src/value.ts", "value");
  assert.ok(constSymbol, "value should resolve");

  assert.equal(
    verifyAnchor(createAnchor(constSymbol), "let value = 1;").status,
    "needs_revalidation",
  );

  const exportedSource = "export const value = 1;";
  const exportedSymbol = resolveSymbol(exportedSource, "src/value.ts", "value");
  assert.ok(exportedSymbol, "exported value should resolve");

  assert.equal(
    verifyAnchor(createAnchor(exportedSymbol), "const value = 1;").status,
    "needs_revalidation",
  );
});

test("each supported declaration kind revalidates only its own anchor", () => {
  const names = [
    "Anchor",
    "VerificationResult",
    "createAnchor",
    "observationCount",
    "MemorySession",
    "Physics.gravity",
  ];
  const anchors = new Map(names.map((name) => {
    const symbol = resolveSymbol(observationSource, "src/memory.ts", name);
    assert.ok(symbol, `${name} should resolve`);
    return [name, createAnchor(symbol)];
  }));

  const changes = {
    Anchor: ["fingerprint: string;", "contentFingerprint: string;"],
    VerificationResult: ["| \"orphaned\";", "| \"orphaned\" | \"unknown\";"],
    createAnchor: [
      "return { qualifiedName: symbol, fingerprint: symbol };",
      "return { qualifiedName: symbol, fingerprint: `${symbol}:captured` };",
    ],
    observationCount: ["const observationCount = 1;", "const observationCount = 2;"],
    MemorySession: ["active = true;", "active = false;"],
    "Physics.gravity": ["static gravity = 9.81;", "static gravity = 1.62;"],
  } as const;

  for (const [changedName, [before, after]] of Object.entries(changes)) {
    const changedSource = observationSource.replace(before, after);
    for (const name of names) {
      assert.equal(
        verifyAnchor(anchors.get(name)!, changedSource).status,
        name === changedName ? "needs_revalidation" : "verified",
        `${changedName} should only revalidate its own anchor`,
      );
    }
  }
});

test("duplicate or merged names are ambiguous", () => {
  const mergedInterface = `
interface Duplicate { first: string; }
interface Duplicate { second: number; }
`;

  assert.equal(resolveSymbol(mergedInterface, "src/duplicate.ts", "Duplicate"), null);
});

test("a non-exported declaration resolves successfully", () => {
  const source = "function localHelper(): string { return \"ok\"; }";
  const symbol = resolveSymbol(source, "src/local.ts", "localHelper");

  assert.equal(symbol?.declarationKind, "function");
});
