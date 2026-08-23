import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchClaudeMemObservationById,
  type ClaudeMemRetrievalResult,
} from "./claude-mem.js";
import {
  DEMO_ATOMIC_CLAIM,
  demoProvenanceFromClaudeMem,
  loadCapturedMemory,
  persistCapturedMemory,
} from "./demo-workflow.js";
import {
  applyLunarMigrationFixture,
  RevalidatedGravityController,
  resetEarthFixture,
  simulateVerticalLanding,
  StaleEarthGravityController,
} from "./lunar-lander-fixture.js";
import {
  createMissionCalibrationStore,
  type MissionCalibration,
  type MissionCalibrationStore,
} from "./mission-calibration.js";
import { createProjectSourceReader } from "./node-source-reader.js";
import {
  bindMemoryObservation,
  gateMemoryObservation,
  resolveSymbol,
  type MemoryObservation,
  type SourceReader,
} from "./sourcetether.js";

const TARGET_PATH = "src/descent-model.ts";
const TARGET_SYMBOL = "DescentModel.gravity";
const MAX_BODY_BYTES = 16 * 1024;

export interface MissionApiStorage {
  load(): ReturnType<typeof loadCapturedMemory>;
  save(observation: MemoryObservation): void;
  reset(): void;
}

export interface MissionApiDependencies {
  retrieveObservation(observationId: string): Promise<ClaudeMemRetrievalResult>;
  sourceReader: SourceReader;
  calibration: MissionCalibrationStore;
  storage: MissionApiStorage;
}

export function createMissionApi(dependencies: MissionApiDependencies) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/api/state") {
        return sendJson(response, 200, state(dependencies));
      }
      if (request.method === "POST" && request.url === "/api/capture") {
        return await capture(request, response, dependencies);
      }
      if (request.method === "POST" && request.url === "/api/calibration") {
        return await calibrate(request, response, dependencies);
      }
      if (request.method === "POST" && request.url === "/api/reset") {
        dependencies.storage.reset();
        dependencies.calibration.set("earth");
        return sendJson(response, 200, state(dependencies));
      }
      return sendError(response, 404, "not_found");
    } catch {
      return sendError(response, 500, "internal_error");
    }
  };
}

export function createMissionApiServer(dependencies: MissionApiDependencies): Server {
  return createServer(createMissionWebHandler(dependencies));
}

/** Routes the local API and its deliberately small, dependency-free browser client. */
export function createMissionWebHandler(dependencies: MissionApiDependencies) {
  const api = createMissionApi(dependencies);
  const staticFiles: Record<string, { filename: string; contentType: string }> = {
    "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
    "/app.js": { filename: "app.js", contentType: "text/javascript; charset=utf-8" },
    "/styles.css": { filename: "styles.css", contentType: "text/css; charset=utf-8" },
  };
  const publicRoot = resolve(defaultRepositoryRoot(), "public");

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url !== undefined && staticFiles[request.url] !== undefined) {
      const file = staticFiles[request.url];
      try {
        response.writeHead(200, {
          "content-type": file.contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(readFileSync(resolve(publicRoot, file.filename)));
      } catch {
        sendError(response, 500, "static_unavailable");
      }
      return;
    }
    return api(request, response);
  };
}

/** Creates the real local-demo dependencies; the HTTP listener remains local-only in the CLI. */
export function createDefaultMissionApiDependencies(repositoryRoot = defaultRepositoryRoot()): MissionApiDependencies {
  const missionRoot = resolve(repositoryRoot, "demo/mission");
  const capturePath = resolve(missionRoot, ".sourcetether-demo/captured-memory.json");
  const calibration = createMissionCalibrationStore(missionRoot);
  return {
    retrieveObservation: (observationId) => fetchClaudeMemObservationById(
      process.env.SOURCETETHER_CLAUDE_MEM_URL ?? "http://127.0.0.1:37701",
      observationId,
    ),
    sourceReader: createProjectSourceReader(missionRoot),
    calibration,
    storage: {
      load: () => loadCapturedMemory(() => readFileSync(capturePath, "utf8")),
      save: (observation) => {
        mkdirSync(dirname(capturePath), { recursive: true });
        persistCapturedMemory(observation, (serialized) => writeFileSync(capturePath, serialized, "utf8"));
      },
      reset: () => {
        // An empty value deliberately decodes as missing, without deleting user files outside demo storage.
        mkdirSync(dirname(capturePath), { recursive: true });
        writeFileSync(capturePath, "", "utf8");
      },
    },
  };
}

function state(dependencies: MissionApiDependencies): object {
  const calibration = dependencies.calibration.get();
  if (calibration === null) return { calibration: null, target: target(), source: null, gate: { status: "withheld", reason: "source_unreadable", reread: target() }, lander: lander("earth") };

  const captured = dependencies.storage.load();
  const observation = captured.status === "loaded" ? captured.observation : undefined;
  const source = currentSource(dependencies.sourceReader, observation);
  const gate = observation !== undefined
    ? gateMemoryObservation(observation, dependencies.sourceReader)
    : { status: "withheld" as const, reason: "capture_required", reread: target() };
  const earthRelease = calibration === "earth" && gate.status === "released";
  const lunarWithheld = calibration === "lunar"
    && gate.status === "withheld"
    && gate.reason === "fingerprint_changed"
    && source?.matchesCapturedAnchor === false;
  const gateState = earthRelease
    ? { status: "released", claim: gate.observation.content, provenance: provenance(gate.observation) }
    : lunarWithheld
      ? { status: "withheld", reason: "fingerprint_changed", reread: gate.reread, provenance: provenance(observation!) }
      : { status: "withheld", reason: "capture_required", reread: target() };

  return { calibration, target: target(), source, gate: gateState, lander: lander(calibration) };
}

async function capture(request: IncomingMessage, response: ServerResponse, dependencies: MissionApiDependencies): Promise<void> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || !isNonEmptyString(body.observationId) || Object.keys(body).length !== 1) {
    return sendError(response, 400, "invalid_request");
  }
  if (dependencies.calibration.get() !== "earth") return sendError(response, 409, "capture_requires_earth");
  const retrieved = await dependencies.retrieveObservation(body.observationId);
  if (retrieved.status === "unavailable") return sendError(response, 502, `capture_${retrieved.reason}`);

  const binding = bindMemoryObservation({
    atomicClaim: DEMO_ATOMIC_CLAIM,
    provenance: demoProvenanceFromClaudeMem(retrieved.observation),
    projectRelativePath: TARGET_PATH,
    qualifiedName: TARGET_SYMBOL,
  }, dependencies.sourceReader);
  if (binding.status === "unbound") return sendError(response, 409, `capture_${binding.reason}`);
  dependencies.storage.save(binding.observation);
  return sendJson(response, 200, state(dependencies));
}

async function calibrate(request: IncomingMessage, response: ServerResponse, dependencies: MissionApiDependencies): Promise<void> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || (body.mode !== "earth" && body.mode !== "lunar") || Object.keys(body).length !== 1) {
    return sendError(response, 400, "invalid_request");
  }
  dependencies.calibration.set(body.mode);
  return sendJson(response, 200, state(dependencies));
}

function lander(calibration: MissionCalibration) {
  calibration === "lunar" ? applyLunarMigrationFixture() : resetEarthFixture();
  return {
    stale: simulateVerticalLanding(new StaleEarthGravityController()),
    revalidated: simulateVerticalLanding(new RevalidatedGravityController()),
  };
}

function target() {
  return { projectRelativePath: TARGET_PATH, qualifiedName: TARGET_SYMBOL };
}

function provenance(observation: MemoryObservation) {
  return {
    externalObservationId: observation.provenance.externalObservationId,
    boundAt: observation.boundAt,
  };
}

/** Presentation metadata is resolved afresh from the same source used by the gate. */
function currentSource(readSource: SourceReader, observation?: MemoryObservation) {
  let text: string | null | undefined;
  try {
    text = readSource(TARGET_PATH);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  const symbol = resolveSymbol(text, TARGET_PATH, TARGET_SYMBOL);
  if (symbol === null) return null;
  return {
    declarationText: text.slice(symbol.declarationStart, symbol.declarationEnd),
    declarationKind: symbol.declarationKind,
    declarationSpan: { start: symbol.declarationStart, end: symbol.declarationEnd },
    currentFingerprint: shortFingerprint(symbol.fingerprint),
    ...(observation === undefined ? {} : {
      capturedFingerprint: shortFingerprint(observation.anchor.fingerprint),
      matchesCapturedAnchor: observation.anchor.fingerprint === symbol.fingerprint,
    }),
  };
}

function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 12)}…${fingerprint.slice(-6)}`;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, payload: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}
