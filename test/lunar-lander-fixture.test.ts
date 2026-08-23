import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLunarMigrationFixture,
  DescentModel,
  EARTH_GRAVITY_METERS_PER_SECOND_SQUARED,
  LUNAR_GRAVITY_METERS_PER_SECOND_SQUARED,
  RevalidatedGravityController,
  resetEarthFixture,
  simulateVerticalLanding,
  StaleEarthGravityController,
} from "../src/lunar-lander-fixture.js";

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("the lunar migration changes gravity without changing its TypeScript value shape", () => {
  resetEarthFixture();
  assert.equal(DescentModel.gravity, EARTH_GRAVITY_METERS_PER_SECOND_SQUARED);

  applyLunarMigrationFixture();
  assert.equal(DescentModel.gravity, LUNAR_GRAVITY_METERS_PER_SECOND_SQUARED);
  assert.equal(typeof DescentModel.gravity, "number");

  resetEarthFixture();
});

test("on lunar gravity a stale Earth controller exhausts fuel while a revalidated controller soft-lands", () => {
  applyLunarMigrationFixture();
  try {
    const stale = simulateVerticalLanding(new StaleEarthGravityController());
    const revalidated = simulateVerticalLanding(new RevalidatedGravityController());

    assert.equal(stale.outcome, "fuel_depleted");
    assertClose(stale.finalState.altitudeMeters, 491.4045184);
    assertClose(stale.finalState.verticalVelocityMetersPerSecond, 67.644);
    assert.equal(revalidated.outcome, "soft_landing");
    assertClose(revalidated.finalState.verticalVelocityMetersPerSecond, -1.5);
    assertClose(revalidated.finalState.fuelUnits, 4.331);
  } finally {
    resetEarthFixture();
  }
});

test("landing trajectories expose timestamped samples for a later visualizer", () => {
  applyLunarMigrationFixture();
  try {
    const result = simulateVerticalLanding(new RevalidatedGravityController());

    assert.equal(result.trajectory[0].timeSeconds, 0);
    assertClose(result.trajectory.at(-1)?.timeSeconds ?? Number.NaN, 24.4);
    assert.ok(result.trajectory.every((sample, index) => (
      index === 0 || sample.timeSeconds > result.trajectory[index - 1].timeSeconds
    )));
    assert.ok(result.trajectory.every((sample) => Number.isFinite(sample.altitudeMeters)));
  } finally {
    resetEarthFixture();
  }
});
