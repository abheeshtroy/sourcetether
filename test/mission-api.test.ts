import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { ClaudeMemRetrievalResult } from "../src/claude-mem.js";
import {
  createMissionApi,
  createMissionWebHandler,
  type MissionApiDependencies,
  type MissionApiStorage,
} from "../src/mission-api.js";
import type { MissionCalibration, MissionCalibrationStore } from "../src/mission-calibration.js";
import { loadCapturedMemory } from "../src/demo-workflow.js";
import type { MemoryObservation } from "../src/sourcetether.js";

const projectRoot = process.cwd();
const earthSource = readFileSync(resolve(projectRoot, "demo/mission/templates/descent-model.earth.ts"), "utf8");
const lunarSource = readFileSync(resolve(projectRoot, "demo/mission/templates/descent-model.lunar.ts"), "utf8");

test("mission API binds retrieved observations without exposing their raw Claude-Mem text", async () => {
  const harness = createHarness(async () => ({
    status: "found",
    observation: {
      id: "42",
      content: "Untrusted Claude-Mem narrative that must never be returned.",
      capturedAt: "2026-08-23T12:00:00.000Z",
    },
  }));
  const api = createMissionApi(harness.dependencies);

  const initial = await request(api, "/api/state");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.gate, {
    status: "withheld",
    reason: "capture_required",
    reread: { projectRelativePath: "src/descent-model.ts", qualifiedName: "DescentModel.gravity" },
  });
  assert.deepEqual(initial.body.source, {
    declarationText: earthSource.slice(earthSource.indexOf("static gravity"), earthSource.indexOf(";", earthSource.indexOf("static gravity")) + 1),
    declarationKind: "class_static_property",
    declarationSpan: initial.body.source.declarationSpan,
    currentFingerprint: initial.body.source.currentFingerprint,
  });

  const captured = await request(api, "/api/capture", { observationId: "42" });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.gate.status, "released");
  assert.match(captured.body.gate.claim, /numeric literal 9\.81/);
  assert.equal(captured.body.source.capturedFingerprint, captured.body.source.currentFingerprint);
  assert.equal(captured.body.source.matchesCapturedAnchor, true);
  assert.equal(JSON.stringify(captured.body).includes("Untrusted Claude-Mem narrative"), false);
  assert.equal(captured.body.lander.stale.trajectory.length > 1, true);
  assert.equal(captured.body.lander.revalidated.trajectory.length > 1, true);

  const lunar = await request(api, "/api/calibration", { mode: "lunar" });
  assert.equal(lunar.status, 200);
  assert.deepEqual(lunar.body.gate, {
    status: "withheld",
    reason: "fingerprint_changed",
    reread: { projectRelativePath: "src/descent-model.ts", qualifiedName: "DescentModel.gravity" },
    provenance: {
      externalObservationId: "42",
      boundAt: lunar.body.gate.provenance.boundAt,
    },
  });
  assert.equal("claim" in lunar.body.gate, false);
  assert.equal(lunar.body.gate.provenance.externalObservationId, "42");
  assert.notEqual(lunar.body.source.currentFingerprint, lunar.body.source.capturedFingerprint);
  assert.equal(lunar.body.source.matchesCapturedAnchor, false);
  assert.match(lunar.body.source.declarationText, /static gravity/);
  assert.notEqual(lunar.body.lander.stale.outcome, lunar.body.lander.revalidated.outcome);
});

test("mission API rejects malformed requests, retrieval failures, and resets to Earth", async () => {
  const harness = createHarness(async () => ({ status: "unavailable", reason: "not_found" }));
  const api = createMissionApi(harness.dependencies);

  const malformed = await request(api, "/api/calibration", { mode: "mars" });
  assert.deepEqual(malformed, { status: 400, body: { error: "invalid_request" } });
  const unavailable = await request(api, "/api/capture", { observationId: "missing" });
  assert.deepEqual(unavailable, { status: 502, body: { error: "capture_not_found" } });

  await request(api, "/api/calibration", { mode: "lunar" });
  const lunarCapture = await request(api, "/api/capture", { observationId: "10" });
  assert.deepEqual(lunarCapture, { status: 409, body: { error: "capture_requires_earth" } });
  const reset = await request(api, "/api/reset", {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.calibration, "earth");
  assert.equal(reset.body.gate.reason, "capture_required");
  assert.equal(harness.calibration.get(), "earth");
});

test("mission web handler serves only the bundled browser entry points", async () => {
  const harness = createHarness(async () => ({ status: "unavailable", reason: "not_found" }));
  const web = createMissionWebHandler(harness.dependencies);
  const served = await staticRequest(web, "/");
  assert.equal(served.status, 200);
  assert.match(served.body, /SourceTether/);
  assert.match(served.body, /id="hero"/);
  assert.match(served.contentType, /text\/html/);

  /* The mission console shows only what the gate released, so no gravity value
     may be baked into its markup: every value in it has to arrive from the API
     at runtime. The narrative sections around the console are editorial copy
     about the demo and never feed the gate, so the invariant is asserted on the
     console subtree rather than on the whole document. */
  const consoleStart = served.body.indexOf('<div class="console">');
  const consoleEnd = served.body.indexOf('<p class="console-note"');
  assert.ok(consoleStart > 0 && consoleEnd > consoleStart);
  const missionConsole = served.body.slice(consoleStart, consoleEnd);
  assert.match(missionConsole, /id="stage"/);
  assert.equal(missionConsole.includes("9.81"), false);
  assert.equal(missionConsole.includes("1.62"), false);

  const missing = await staticRequest(web, "/secret.txt");
  assert.deepEqual({ status: missing.status, body: JSON.parse(missing.body) }, {
    status: 404,
    body: { error: "not_found" },
  });
});

function createHarness(retrieveObservation: MissionApiDependencies["retrieveObservation"]): {
  dependencies: MissionApiDependencies;
  calibration: MissionCalibrationStore;
} {
  let mode: MissionCalibration = "earth";
  let captured: MemoryObservation | undefined;
  const calibration: MissionCalibrationStore = {
    get: () => mode,
    set: (next) => { mode = next; },
  };
  const storage: MissionApiStorage = {
    load: () => captured === undefined
      ? loadCapturedMemory(() => "")
      : { status: "loaded", observation: captured },
    save: (observation) => { captured = observation; },
    reset: () => { captured = undefined; },
  };
  return {
    calibration,
    dependencies: {
      retrieveObservation,
      sourceReader: (path) => path === "src/descent-model.ts"
        ? (mode === "earth" ? earthSource : lunarSource)
        : undefined,
      calibration,
      storage,
    },
  };
}

async function request(
  api: ReturnType<typeof createMissionApi>,
  pathname: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
    { method: body === undefined ? "GET" : "POST", url: pathname },
  );
  let status = 0;
  let serialized = "";
  const response = {
    writeHead: (nextStatus: number) => { status = nextStatus; },
    end: (payload: string) => { serialized = payload; },
  };
  await api(request as never, response as never);
  return { status, body: JSON.parse(serialized) };
}

async function staticRequest(
  handler: ReturnType<typeof createMissionWebHandler>,
  pathname: string,
): Promise<{ status: number; body: string; contentType: string }> {
  const request = Object.assign(Readable.from([]), { method: "GET", url: pathname });
  let status = 0;
  let body = "";
  let contentType = "";
  const response = {
    writeHead: (nextStatus: number, headers?: Record<string, string>) => {
      status = nextStatus;
      contentType = headers?.["content-type"] ?? "";
    },
    end: (payload: string | Buffer) => { body = Buffer.from(payload).toString("utf8"); },
  };
  await handler(request as never, response as never);
  return { status, body, contentType };
}
