import { copyFileSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type MissionCalibration = "earth" | "lunar";

export interface MissionCalibrationStore {
  get(): MissionCalibration | null;
  set(mode: MissionCalibration): void;
}

/**
 * Provides the demo's deliberately bounded Earth/lunar source switch. Paths are
 * resolved once and checked before any source file is copied.
 */
export function createMissionCalibrationStore(missionRoot: string): MissionCalibrationStore {
  const root = realpathSync(missionRoot);
  const activeSourcePath = inside(root, "src/descent-model.ts");
  const templates: Record<MissionCalibration, string> = {
    earth: inside(root, "templates/descent-model.earth.ts"),
    lunar: inside(root, "templates/descent-model.lunar.ts"),
  };

  return {
    get(): MissionCalibration | null {
      let activeSource: string;
      try {
        activeSource = readFileSync(activeSourcePath, "utf8");
      } catch {
        return null;
      }

      for (const mode of ["earth", "lunar"] as const) {
        try {
          if (activeSource === readFileSync(templates[mode], "utf8")) return mode;
        } catch {
          return null;
        }
      }
      return null;
    },
    set(mode: MissionCalibration): void {
      copyFileSync(templates[mode], activeSourcePath);
    },
  };
}

function inside(root: string, child: string): string {
  if (isAbsolute(child)) throw new Error("Mission source path must be relative");
  const candidate = resolve(root, child);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Mission source path must stay inside demo/mission");
  }
  return candidate;
}
