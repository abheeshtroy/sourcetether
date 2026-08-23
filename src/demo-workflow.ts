import type { ClaudeMemObservation } from "./claude-mem.js";
import type {
  ClaudeMemProvenance,
  MemoryObservation,
  SymbolDeclarationKind,
} from "./sourcetether.js";

/** The deliberately narrow claim demonstrated by the local mission workflow. */
export const DEMO_ATOMIC_CLAIM =
  "DescentModel.gravity is a static property of class DescentModel initialized to the numeric literal 9.81.";

export type CapturedMemoryLoadResult =
  | { status: "loaded"; observation: MemoryObservation }
  | { status: "missing_or_malformed" };

/** Copies only provenance fields; the external observation text is never used as the claim. */
export function demoProvenanceFromClaudeMem(
  observation: ClaudeMemObservation,
): ClaudeMemProvenance {
  return {
    externalObservationId: observation.id,
    capturedAt: observation.capturedAt,
    ...(observation.project === undefined ? {} : { project: observation.project }),
    ...(observation.memorySessionId === undefined
      ? {}
      : { memorySessionId: observation.memorySessionId }),
    ...(observation.contentSessionId === undefined
      ? {}
      : { contentSessionId: observation.contentSessionId }),
  };
}

export function serializeCapturedMemory(observation: MemoryObservation): string {
  return `${JSON.stringify(observation, null, 2)}\n`;
}

/** Injection keeps local persistence behavior testable without filesystem or worker access. */
export function persistCapturedMemory(
  observation: MemoryObservation,
  write: (serialized: string) => void,
): void {
  write(serializeCapturedMemory(observation));
}

export function loadCapturedMemory(read: () => string): CapturedMemoryLoadResult {
  try {
    const value: unknown = JSON.parse(read());
    return isMemoryObservation(value)
      ? { status: "loaded", observation: value }
      : { status: "missing_or_malformed" };
  } catch {
    return { status: "missing_or_malformed" };
  }
}

function isMemoryObservation(value: unknown): value is MemoryObservation {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.content) ||
    !isTimestamp(value.capturedAt) ||
    !isTimestamp(value.boundAt) ||
    value.source !== "claude-mem" ||
    !isProvenance(value.provenance) ||
    !isAnchor(value.anchor)
  ) {
    return false;
  }

  return value.capturedAt === value.provenance.capturedAt;
}

function isProvenance(value: unknown): value is ClaudeMemProvenance {
  return (
    isRecord(value) &&
    isNonEmptyString(value.externalObservationId) &&
    isTimestamp(value.capturedAt) &&
    optionalString(value.project) &&
    optionalString(value.memorySessionId) &&
    optionalString(value.contentSessionId)
  );
}

function isAnchor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.qualifiedName) &&
    isDeclarationKind(value.declarationKind) &&
    isNonEmptyString(value.projectRelativePath) &&
    isNonEmptyString(value.fingerprint)
  );
}

function isDeclarationKind(value: unknown): value is SymbolDeclarationKind {
  return (
    value === "interface" ||
    value === "type_alias" ||
    value === "function" ||
    value === "variable" ||
    value === "class" ||
    value === "class_static_property"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  return Number.isFinite(Date.parse(value));
}
