import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync as readSourceFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { resolveSymbol } from "../src/sourcetether.js";

const projectRoot = process.cwd();
const activeSourcePath = resolve(projectRoot, "demo/mission/src/descent-model.ts");
const earthTemplatePath = resolve(projectRoot, "demo/mission/templates/descent-model.earth.ts");
const lunarTemplatePath = resolve(projectRoot, "demo/mission/templates/descent-model.lunar.ts");
const gravityScriptPath = resolve(projectRoot, "scripts/set-mission-gravity.mjs");
const projectRelativePath = "demo/mission/src/descent-model.ts";

test("Earth and lunar mission templates keep the same symbol shape with different fingerprints", () => {
  const earth = resolveSymbol(
    readSourceFileSync(earthTemplatePath, "utf8"),
    projectRelativePath,
    "DescentModel.gravity",
  );
  const lunar = resolveSymbol(
    readSourceFileSync(lunarTemplatePath, "utf8"),
    projectRelativePath,
    "DescentModel.gravity",
  );

  assert.ok(earth, "Earth template should resolve DescentModel.gravity");
  assert.ok(lunar, "lunar template should resolve DescentModel.gravity");
  assert.equal(earth.declarationKind, lunar.declarationKind);
  assert.equal(earth.qualifiedName, lunar.qualifiedName);
  assert.equal(earth.projectRelativePath, lunar.projectRelativePath);
  assert.notEqual(earth.fingerprint, lunar.fingerprint);
});

test("mission gravity script switches modes explicitly and restores Earth source", () => {
  runGravityScript("earth");
  assert.equal(readSourceFileSync(activeSourcePath, "utf8"), readSourceFileSync(earthTemplatePath, "utf8"));

  try {
    assert.equal(runGravityScript("lunar"), "lunar demo/mission/src/descent-model.ts\n");
    assert.equal(readSourceFileSync(activeSourcePath, "utf8"), readSourceFileSync(lunarTemplatePath, "utf8"));
  } finally {
    runGravityScript("earth");
  }

  assert.equal(readSourceFileSync(activeSourcePath, "utf8"), readSourceFileSync(earthTemplatePath, "utf8"));
});

test("mission gravity script rejects unknown modes without changing the active source", () => {
  runGravityScript("earth");
  const earthSource = readSourceFileSync(activeSourcePath, "utf8");

  assert.throws(() => runGravityScript("mars"));
  assert.equal(readSourceFileSync(activeSourcePath, "utf8"), earthSource);
});

function runGravityScript(mode: "earth" | "lunar" | "mars"): string {
  return execFileSync(process.execPath, [gravityScriptPath, mode], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
