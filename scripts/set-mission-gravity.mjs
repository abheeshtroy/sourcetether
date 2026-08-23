import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMissionCalibrationStore } from "../dist/src/mission-calibration.js";

const mode = process.argv[2];
if (mode !== "earth" && mode !== "lunar") {
  process.stderr.write("Usage: node scripts/set-mission-gravity.mjs earth|lunar\n");
  process.exitCode = 1;
} else {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const missionRoot = resolve(projectRoot, "demo/mission");
  createMissionCalibrationStore(missionRoot).set(mode);
  process.stdout.write(`${mode} demo/mission/src/descent-model.ts\n`);
}
