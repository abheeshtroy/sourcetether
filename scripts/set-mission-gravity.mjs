import { copyFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "earth" && mode !== "lunar") {
  process.stderr.write("Usage: node scripts/set-mission-gravity.mjs earth|lunar\n");
  process.exitCode = 1;
} else {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const missionRoot = resolve(projectRoot, "demo/mission");
  const templatePath = resolve(missionRoot, "templates", `descent-model.${mode}.ts`);
  const activeSourcePath = resolve(missionRoot, "src/descent-model.ts");

  if (!isInsideMission(missionRoot, templatePath) || !isInsideMission(missionRoot, activeSourcePath)) {
    throw new Error("Mission gravity script refused a path outside demo/mission");
  }

  copyFileSync(templatePath, activeSourcePath);
  process.stdout.write(`${mode} demo/mission/src/descent-model.ts\n`);
}

function isInsideMission(missionRoot, candidatePath) {
  const pathFromMission = relative(missionRoot, candidatePath);
  return pathFromMission !== "" && !pathFromMission.startsWith("..") && !pathFromMission.includes("../");
}
