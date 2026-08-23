/** Controlled SourceTether demo fixture; not part of the retrieval-gate product. */

export const EARTH_GRAVITY_METERS_PER_SECOND_SQUARED = 9.81;
export const LUNAR_GRAVITY_METERS_PER_SECOND_SQUARED = 1.62;

export class DescentModel {
  /** Remains a number across the Earth-to-Moon migration. */
  static gravity: number = EARTH_GRAVITY_METERS_PER_SECOND_SQUARED;
}

export type LandingOutcome = "soft_landing" | "hard_landing" | "crash" | "fuel_depleted";

export interface DescentState {
  altitudeMeters: number;
  verticalVelocityMetersPerSecond: number;
  fuelUnits: number;
}

export interface TrajectorySample extends DescentState {
  timeSeconds: number;
  thrust: number;
}

export interface LandingResult {
  outcome: LandingOutcome;
  finalState: DescentState;
  trajectory: TrajectorySample[];
}

export interface LandingSimulationParameters {
  initialAltitudeMeters: number;
  initialVerticalVelocityMetersPerSecond: number;
  initialFuelUnits: number;
  fixedTimeStepSeconds: number;
  maximumThrustAccelerationMetersPerSecondSquared: number;
  fuelBurnRateUnitsPerSecondAtFullThrust: number;
  softLandingSpeedMetersPerSecond: number;
  hardLandingSpeedMetersPerSecond: number;
}

export const DEFAULT_LANDING_PARAMETERS: LandingSimulationParameters = {
  initialAltitudeMeters: 40,
  initialVerticalVelocityMetersPerSecond: -6,
  initialFuelUnits: 8,
  fixedTimeStepSeconds: 0.1,
  maximumThrustAccelerationMetersPerSecondSquared: 12,
  fuelBurnRateUnitsPerSecondAtFullThrust: 1,
  softLandingSpeedMetersPerSecond: 2,
  hardLandingSpeedMetersPerSecond: 6,
};

export interface DescentController {
  readonly name: string;
  chooseThrust(state: DescentState): number;
}

const TARGET_DESCENT_SPEED_METERS_PER_SECOND = -1.5;
const VELOCITY_CORRECTION_GAIN = 2;
const MAXIMUM_CORRECTION_ACCELERATION_METERS_PER_SECOND_SQUARED = 3;

/** Deliberately stale: this remembered constant remains Earth gravity. */
export class StaleEarthGravityController implements DescentController {
  readonly name = "stale_earth_gravity";
  private readonly rememberedGravity = EARTH_GRAVITY_METERS_PER_SECOND_SQUARED;

  chooseThrust(state: DescentState): number {
    return thrustForGravityEstimate(this.rememberedGravity, state);
  }
}

/** Re-reads the current source model value whenever it chooses a thrust level. */
export class RevalidatedGravityController implements DescentController {
  readonly name = "revalidated_current_gravity";

  chooseThrust(state: DescentState): number {
    return thrustForGravityEstimate(DescentModel.gravity, state);
  }
}

export function applyLunarMigrationFixture(): void {
  DescentModel.gravity = LUNAR_GRAVITY_METERS_PER_SECOND_SQUARED;
}

export function resetEarthFixture(): void {
  DescentModel.gravity = EARTH_GRAVITY_METERS_PER_SECOND_SQUARED;
}

export function simulateVerticalLanding(
  controller: DescentController,
  parameters: LandingSimulationParameters = DEFAULT_LANDING_PARAMETERS,
): LandingResult {
  const state: DescentState = {
    altitudeMeters: parameters.initialAltitudeMeters,
    verticalVelocityMetersPerSecond: parameters.initialVerticalVelocityMetersPerSecond,
    fuelUnits: parameters.initialFuelUnits,
  };
  const trajectory: TrajectorySample[] = [{ timeSeconds: 0, thrust: 0, ...state }];
  let timeSeconds = 0;

  // This fixture's controllers either land or consume finite fuel; this guard
  // protects callers from a custom controller that never reaches either state.
  for (let step = 0; step < 10_000; step += 1) {
    const requestedThrust = clamp(controller.chooseThrust(state), 0, 1);
    const availableThrust = Math.min(
      requestedThrust,
      state.fuelUnits / (parameters.fuelBurnRateUnitsPerSecondAtFullThrust * parameters.fixedTimeStepSeconds),
    );
    state.fuelUnits -= availableThrust
      * parameters.fuelBurnRateUnitsPerSecondAtFullThrust
      * parameters.fixedTimeStepSeconds;

    const acceleration = availableThrust * parameters.maximumThrustAccelerationMetersPerSecondSquared
      - DescentModel.gravity;
    state.verticalVelocityMetersPerSecond += acceleration * parameters.fixedTimeStepSeconds;
    state.altitudeMeters += state.verticalVelocityMetersPerSecond * parameters.fixedTimeStepSeconds;
    timeSeconds += parameters.fixedTimeStepSeconds;
    trajectory.push({ timeSeconds, thrust: availableThrust, ...state });

    if (state.altitudeMeters <= 0) {
      state.altitudeMeters = 0;
      trajectory[trajectory.length - 1].altitudeMeters = 0;
      return { outcome: impactOutcome(state.verticalVelocityMetersPerSecond, parameters), finalState: state, trajectory };
    }
    if (state.fuelUnits <= 0) {
      state.fuelUnits = 0;
      trajectory[trajectory.length - 1].fuelUnits = 0;
      return { outcome: "fuel_depleted", finalState: state, trajectory };
    }
  }

  throw new Error("Landing fixture did not reach a terminal outcome");
}

function thrustForGravityEstimate(gravityEstimate: number, state: DescentState): number {
  const velocityError = TARGET_DESCENT_SPEED_METERS_PER_SECOND - state.verticalVelocityMetersPerSecond;
  const desiredNetAcceleration = clamp(
    velocityError * VELOCITY_CORRECTION_GAIN,
    -MAXIMUM_CORRECTION_ACCELERATION_METERS_PER_SECOND_SQUARED,
    MAXIMUM_CORRECTION_ACCELERATION_METERS_PER_SECOND_SQUARED,
  );
  return (gravityEstimate + desiredNetAcceleration)
    / DEFAULT_LANDING_PARAMETERS.maximumThrustAccelerationMetersPerSecondSquared;
}

function impactOutcome(
  verticalVelocityMetersPerSecond: number,
  parameters: LandingSimulationParameters,
): LandingOutcome {
  const impactSpeed = Math.abs(verticalVelocityMetersPerSecond);
  if (impactSpeed <= parameters.softLandingSpeedMetersPerSecond) return "soft_landing";
  if (impactSpeed <= parameters.hardLandingSpeedMetersPerSecond) return "hard_landing";
  return "crash";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
