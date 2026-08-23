import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchClaudeMemObservationById } from "../dist/src/claude-mem.js";
import {
  DEMO_ATOMIC_CLAIM,
  demoProvenanceFromClaudeMem,
  loadCapturedMemory,
  persistCapturedMemory,
} from "../dist/src/demo-workflow.js";
import { createProjectSourceReader } from "../dist/src/node-source-reader.js";
import { bindMemoryObservation, gateMemoryObservation } from "../dist/src/sourcetether.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const missionRoot = resolve(repositoryRoot, "demo", "mission");
const captureDirectory = resolve(missionRoot, ".sourcetether-demo");
const capturePath = resolve(captureDirectory, "captured-memory.json");
const targetPath = "src/descent-model.ts";
const qualifiedName = "DescentModel.gravity";
const defaultBaseUrl = "http://127.0.0.1:37701";

if (!isInsideMission(captureDirectory) || !isInsideMission(capturePath)) {
  throw new Error("Demo storage path must remain inside demo/mission.");
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "capture") {
  await capture(arguments_);
} else if (command === "status") {
  status(arguments_);
} else {
  usage();
  process.exitCode = 1;
}

async function capture(arguments_) {
  if (arguments_.length < 1 || arguments_.length > 2 || arguments_[0].trim().length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const [observationId, baseUrl = defaultBaseUrl] = arguments_;
  const retrieved = await fetchClaudeMemObservationById(baseUrl, observationId);
  if (retrieved.status === "unavailable") {
    console.error(`capture unavailable: ${retrieved.reason}`);
    process.exitCode = 1;
    return;
  }

  const binding = bindMemoryObservation(
    {
      atomicClaim: DEMO_ATOMIC_CLAIM,
      provenance: demoProvenanceFromClaudeMem(retrieved.observation),
      projectRelativePath: targetPath,
      qualifiedName,
    },
    createProjectSourceReader(missionRoot),
  );
  if (binding.status === "unbound") {
    console.error(`capture unbound: ${binding.reason}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(captureDirectory, { recursive: true });
  persistCapturedMemory(binding.observation, (serialized) => {
    writeFileSync(capturePath, serialized, "utf8");
  });
  console.log("captured");
  console.log(`external observation ID: ${retrieved.observation.id}`);
  console.log(`bound memory ID: ${binding.observation.id}`);
  console.log(`target: ${targetPath}#${qualifiedName}`);
  console.log(`boundAt: ${binding.observation.boundAt}`);
}

function status(arguments_) {
  if (arguments_.length !== 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const captured = loadCapturedMemory(() => readFileSync(capturePath, "utf8"));
  if (captured.status === "missing_or_malformed") {
    console.error("capture state missing or malformed");
    process.exitCode = 1;
    return;
  }

  const result = gateMemoryObservation(captured.observation, createProjectSourceReader(missionRoot));
  if (result.status === "released") {
    console.log("status: released");
    console.log(`target: ${result.symbol.projectRelativePath}#${result.symbol.qualifiedName}`);
    console.log(`claim: ${result.observation.content}`);
    return;
  }

  console.log("status: withheld");
  console.log(`reason: ${result.reason}`);
  console.log(`target: ${result.reread.projectRelativePath}#${result.reread.qualifiedName}`);
  console.log(`re-read: ${result.reread.projectRelativePath}#${result.reread.qualifiedName}`);
}

function isInsideMission(candidate) {
  const relativePath = relative(missionRoot, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function usage() {
  console.error("Usage: node scripts/source-tether-demo.mjs capture <observationId> [baseUrl]");
  console.error("       node scripts/source-tether-demo.mjs status");
}
