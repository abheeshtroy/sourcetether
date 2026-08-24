/* SourceTether — mission stage.

   Everything drawn here is derived from one API response. The scene is a pure
   function of (mission state, cue progress, clock): no scripted values, no
   remembered claim text once the gate withholds it, and no drawing path that
   can show a state the API did not report.

   Reading order: constants, invariants, cues, DOM chrome, scene painting,
   lander, tether, frame loop, wiring. */

/* ------------------------------------------------------------------ setup */

const el = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const STAGE = el("stage");
const CANVAS = el("hero");
const CTX = CANVAS.getContext("2d");

/** Wall time of one replay. The sim's own seconds are mapped onto this. */
const REPLAY_MS = 8600;
/** The one ground line: terrain art, lander feet and dust all sit on it. */
const GROUND = 0.878;
const CAPTURE_MS = 1400;
const MIGRATE_MS = 2600;
const ENV_MS = 1100;
const SETTLE_STATIC_MS = 2500; /* reduced motion: how long the still frame holds */

const TEAL = [90, 235, 212];
const AMBER = [251, 191, 36];
const GREEN = [52, 211, 153];
const ORANGE = [251, 146, 60];

/* Vercel serves this same client as a deliberately self-contained walkthrough.
   Localhost always uses the real HTTP API, local source files and Claude-Mem
   adapter. Nothing in hosted mode calls a local address or accepts a retrieval
   identifier. */
const HOSTED_GUIDED_DEMO = !["127.0.0.1", "localhost", "::1"].includes(location.hostname);
const GUIDED_STORAGE_KEY = "sourcetether.guided-demo.v1";
const GUIDED_TARGET = { projectRelativePath: "src/descent-model.ts", qualifiedName: "DescentModel.gravity" };
const GUIDED_CLAIM = "DescentModel.gravity is a static property of class DescentModel initialized to the numeric literal 9.81.";
const GUIDED_EARTH_DECLARATION = "static gravity = 9.81;";
const GUIDED_LUNAR_DECLARATION = "static gravity = 1.62;";

function guidedState() {
  try { return JSON.parse(sessionStorage.getItem(GUIDED_STORAGE_KEY) ?? '{"captured":false,"calibration":"earth"}'); }
  catch { return { captured: false, calibration: "earth" }; }
}

function saveGuidedState(next) { sessionStorage.setItem(GUIDED_STORAGE_KEY, JSON.stringify(next)); }

function guidedLanding(controllerGravity) {
  const state = { altitudeMeters: 40, verticalVelocityMetersPerSecond: -6, fuelUnits: 8 };
  const trajectory = [{ timeSeconds: 0, thrust: 0, ...state }];
  for (let step = 0, timeSeconds = 0; step < 10000; step += 1) {
    const desired = Math.max(-3, Math.min(3, (-1.5 - state.verticalVelocityMetersPerSecond) * 2));
    const requested = Math.max(0, Math.min(1, (controllerGravity + desired) / 12));
    const thrust = Math.min(requested, state.fuelUnits / 0.1);
    state.fuelUnits -= thrust * 0.1;
    state.verticalVelocityMetersPerSecond += (thrust * 12 - 1.62) * 0.1;
    state.altitudeMeters += state.verticalVelocityMetersPerSecond * 0.1;
    timeSeconds += 0.1;
    trajectory.push({ timeSeconds, thrust, ...state });
    if (state.altitudeMeters <= 0) {
      state.altitudeMeters = 0; trajectory.at(-1).altitudeMeters = 0;
      const speed = Math.abs(state.verticalVelocityMetersPerSecond);
      return { outcome: speed <= 2 ? "soft_landing" : speed <= 6 ? "hard_landing" : "crash", finalState: state, trajectory };
    }
    if (state.fuelUnits <= 0) { state.fuelUnits = 0; trajectory.at(-1).fuelUnits = 0; return { outcome: "fuel_depleted", finalState: state, trajectory }; }
  }
  throw new Error("guided_fixture_failed");
}

function guidedMission() {
  const state = guidedState();
  const lunar = state.calibration === "lunar";
  const declarationText = lunar ? GUIDED_LUNAR_DECLARATION : GUIDED_EARTH_DECLARATION;
  const source = {
    declarationText, declarationKind: "class_static_property",
    declarationSpan: { start: 0, end: declarationText.length },
    currentFingerprint: lunar ? "guided-lunar…b7c2e1" : "guided-earth…9a81f0",
    ...(state.captured ? { capturedFingerprint: "guided-earth…9a81f0", matchesCapturedAnchor: !lunar } : {}),
  };
  const provenance = { externalObservationId: "guided-fixture", boundAt: "deterministic fixture" };
  const gate = !state.captured
    ? { status: "withheld", reason: "capture_required", reread: GUIDED_TARGET }
    : lunar
      ? { status: "withheld", reason: "fingerprint_changed", reread: GUIDED_TARGET, provenance }
      : { status: "released", claim: GUIDED_CLAIM, provenance };
  return { calibration: state.calibration, target: GUIDED_TARGET, source, gate,
    lander: { stale: guidedLanding(9.81), revalidated: guidedLanding(1.62) } };
}

async function guidedApi(path) {
  const state = guidedState();
  if (path === "/api/capture") saveGuidedState({ ...state, captured: true, calibration: "earth" });
  else if (path === "/api/calibration") saveGuidedState({ ...state, calibration: "lunar" });
  else if (path === "/api/reset") saveGuidedState({ captured: false, calibration: "earth" });
  return guidedMission();
}

const OUTCOME_LABEL = {
  soft_landing: "Touchdown",
  hard_landing: "Hard landing",
  crash: "Crash",
  fuel_depleted: "Fuel depleted",
};

const app = {
  mission: null,
  phase: "boot",       // boot | empty | earth | lunar | replay | settled
  envFrom: 0,          // 0 = Earth, 1 = Moon
  envTo: 0,
  cues: new Map(),
  replay: null,        // { start, simSeconds } while a replay is running
  results: null,       // frozen real outcomes, shown after a replay
  view: { w: 0, h: 0 },
  dust: [],
  pulse: null,         // { start } touchdown pulse
  busy: false,
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smoothstep = (k) => k * k * (3 - 2 * k);
/** Re-maps a 0..1 progress onto the [a,b] slice of it, clamped. */
const sub = (p, a, b) => clamp((p - a) / (b - a), 0, 1);

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------- api */

async function api(path, body) {
  if (HOSTED_GUIDED_DEMO) return guidedApi(path, body);
  const init = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({ error: "invalid_response" }));
  if (!response.ok) throw new Error(payload.error || "request_failed");
  return payload;
}

/* ------------------------------------------------------------ invariants

   The UI never infers a state it was not told. Both predicates require every
   field of the state to agree, so a partial or contradictory response falls
   through to the honest "no bound memory" frame rather than to a half-lit
   claim or to a Moon-plus-released frame. */

function isEarthReleased(m) {
  return m !== null
    && m.calibration === "earth"
    && m.gate?.status === "released"
    && typeof m.gate.claim === "string"
    && m.source?.matchesCapturedAnchor === true;
}

function isLunarWithheld(m) {
  return m !== null
    && m.calibration === "lunar"
    && m.gate?.status === "withheld"
    && m.gate.reason === "fingerprint_changed"
    && m.source?.matchesCapturedAnchor === false
    && rereadTarget(m) !== null;
}

/** The symbol the agent must re-read. Never rendered as "undefined". */
function rereadTarget(m) {
  const target = m?.gate?.reread ?? m?.target ?? null;
  if (target === null) return null;
  const { qualifiedName, projectRelativePath } = target;
  if (typeof qualifiedName !== "string" || qualifiedName.length === 0) return null;
  if (typeof projectRelativePath !== "string" || projectRelativePath.length === 0) return null;
  return { qualifiedName, projectRelativePath };
}

function missionPhase(m) {
  if (m === null) return "boot";
  if (isEarthReleased(m)) return "earth";
  if (isLunarWithheld(m)) return "lunar";
  return "empty";
}

function canReplay(m) {
  return isLunarWithheld(m)
    && Array.isArray(m.lander?.stale?.trajectory) && m.lander.stale.trajectory.length > 1
    && Array.isArray(m.lander?.revalidated?.trajectory) && m.lander.revalidated.trajectory.length > 1;
}

/* ------------------------------------------------------------------ cues

   A cue is a named start time. Every choreographed moment reads its own
   progress out of the clock, so a re-render mid-animation never restarts it
   and reduced motion collapses each cue to its end frame. */

function cue(name, duration) {
  app.cues.set(name, { start: performance.now(), duration });
}

function cueAt(name, now) {
  const entry = app.cues.get(name);
  if (entry === undefined) return null;
  if (reduceMotion.matches) return 1;
  return clamp((now - entry.start) / entry.duration, 0, 1);
}

function envValue(now) {
  if (app.envFrom === app.envTo) return app.envTo;
  const migrate = cueAt("migrate", now);
  const plain = cueAt("env", now);
  const k = migrate !== null ? sub(migrate, 0.12, 0.66) : (plain === null ? 1 : plain);
  return lerp(app.envFrom, app.envTo, smoothstep(k));
}

/** Derived tether topology; no part of it is stored. */
function tetherState(now) {
  const capture = cueAt("capture", now);
  const migrate = cueAt("migrate", now);
  if (app.phase === "earth") {
    return { mode: "intact", drawn: capture === null ? 1 : sub(capture, 0.22, 0.72), lock: capture === null ? 1 : sub(capture, 0.72, 1) };
  }
  if (app.phase === "lunar" || app.phase === "settled") {
    return {
      mode: "broken",
      drawn: 1,
      lock: 1,
      broken: migrate === null ? 1 : sub(migrate, 0.62, 0.82),
      quarantine: migrate === null ? 1 : sub(migrate, 0.8, 1),
      flare: migrate === null ? 0 : 1 - sub(migrate, 0, 0.22),
    };
  }
  return { mode: "none", drawn: 0, lock: 0 };
}

/* ------------------------------------------------------------- DOM chrome */

function renderChrome() {
  const m = app.mission;
  const phase = app.phase;
  document.body.dataset.phase = phase;
  /* `replay` and `settled` are presentation phases laid over a mission state
     that has not changed, so the copy keeps reporting that state rather than
     falling through to the empty-state text. */
  const stated = phase === "replay" || phase === "settled" ? missionPhase(m) : phase;

  const source = m?.source ?? null;
  const reread = m === null ? null : rereadTarget(m);

  el("calibration").textContent = calibrationLabel(m);

  /* Source panel: always the live declaration the gate just read. */
  el("source-declaration").textContent = source?.declarationText ?? "source unreadable";
  el("source-kind").textContent = source?.declarationKind ? source.declarationKind.replace(/_/g, " ") : "—";
  el("source-path").textContent = m?.target?.projectRelativePath ?? "—";

  /* Memory chip: present only once something is actually bound. */
  const provenance = m?.gate?.provenance ?? null;
  const memcard = el("memcard");
  memcard.hidden = provenance === null || phase === "boot";
  if (provenance !== null) {
    el("memory-id").textContent = HOSTED_GUIDED_DEMO ? "guided fixture" : `claude-mem #${provenance.externalObservationId}`;
    el("memory-state").textContent = stated === "earth" ? "verified" : "quarantined";
  }

  /* The focal statement. */
  const verdict = el("verdict");
  const lesson = el("lesson");
  const claim = el("claim");
  const rereadBlock = el("reread");
  el("narrative-kicker").textContent = "Retrieval gate";

  if (stated === "earth") {
    verdict.textContent = "Memory verified";
    lesson.textContent = "This memory still matches its source.";
    /* The claim exists in the DOM only while the gate releases it. */
    claim.textContent = m.gate.claim;
    claim.hidden = false;
    rereadBlock.hidden = true;
  } else if (stated === "lunar") {
    verdict.textContent = "Memory withheld";
    lesson.textContent = "SourceTether does not claim the old memory is false. It withholds it until the source is read again.";
    claim.textContent = "";
    claim.hidden = true;
    rereadBlock.hidden = false;
    el("reread-symbol").textContent = reread.qualifiedName;
    el("reread-reason").textContent = "fingerprint_changed";
  } else if (stated === "boot") {
    verdict.textContent = "Standing by";
    lesson.textContent = "Reading the current source declaration.";
    claim.textContent = "";
    claim.hidden = true;
    rereadBlock.hidden = true;
  } else {
    verdict.textContent = "No bound memory";
    lesson.textContent = m.calibration === null
      ? "The source declaration could not be resolved."
      : "Capture an observation on Earth to bind it to this declaration.";
    claim.textContent = "";
    claim.hidden = true;
    rereadBlock.hidden = true;
  }

  /* Edge instrument marks. */
  el("edge-left").textContent = "sourcetether / retrieval gate";
  el("edge-right").textContent = source === null || source.matchesCapturedAnchor === undefined
    ? "fingerprint / unbound"
    : source.matchesCapturedAnchor ? "fingerprint / match" : "fingerprint / changed";
  el("edge-right").style.color = source?.matchesCapturedAnchor === false ? rgba(AMBER, 0.75) : "";

  renderProof(m);
  renderResults();
  renderActions();
  layoutOverlays();
}

function calibrationLabel(m) {
  if (m === null) return "connecting";
  if (m.calibration === "earth") return "Earth calibration";
  if (m.calibration === "lunar") return "Moon calibration";
  return "source unresolved";
}

function renderProof(m) {
  const source = m?.source ?? null;
  const target = m?.target ?? null;
  const provenance = m?.gate?.provenance ?? null;
  el("proof-anchor").textContent = target ? `${target.projectRelativePath} → ${target.qualifiedName}` : "—";
  el("proof-kind").textContent = source?.declarationKind ?? "—";
  el("proof-captured").textContent = source?.capturedFingerprint ?? "not bound";
  el("proof-current").textContent = source?.currentFingerprint ?? "unreadable";
  el("proof-gate").textContent = m?.gate
    ? (m.gate.status === "released" ? "released" : `withheld · ${m.gate.reason}`)
    : "—";
  el("proof-observation").textContent = provenance
    ? `${provenance.externalObservationId} · bound ${provenance.boundAt}`
    : "—";
  const changed = source?.matchesCapturedAnchor === false;
  el("proof-current").className = changed ? "hot" : source?.matchesCapturedAnchor === true ? "ok" : "";
  el("proof-captured").className = changed ? "hot" : "";
}

function renderResults() {
  const results = el("results");
  if (app.results === null || app.phase === "replay") {
    results.hidden = true;
    return;
  }
  results.hidden = false;
  el("stale-outcome").textContent = outcomeLabel(app.results.stale.outcome);
  el("stale-stat").textContent = finalStat(app.results.stale.finalState);
  el("good-outcome").textContent = outcomeLabel(app.results.revalidated.outcome);
  el("good-stat").textContent = finalStat(app.results.revalidated.finalState);
}

function outcomeLabel(outcome) {
  if (typeof outcome !== "string" || outcome.length === 0) return "No outcome reported";
  return OUTCOME_LABEL[outcome] ?? outcome.replace(/_/g, " ");
}

function finalStat(finalState) {
  if (finalState === null || typeof finalState !== "object") return "—";
  const alt = Number(finalState.altitudeMeters);
  const velocity = Number(finalState.verticalVelocityMetersPerSecond);
  const fuel = Number(finalState.fuelUnits);
  return `${alt.toFixed(1)} m · ${signed(velocity)} m/s · fuel ${fuel.toFixed(2)}`;
}

const signed = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

/** Exactly one action is lit: the next meaningful step in the story. */
function renderActions() {
  const m = app.mission;
  const running = app.phase === "replay" || app.busy;
  const states = {
    capture: !running && app.phase === "empty" && m?.calibration === "earth",
    moon: !running && app.phase === "earth",
    replay: !running && canReplay(m),
    reset: !running && m !== null,
  };
  const primary = states.capture ? "capture"
    : states.moon ? "moon"
      : app.results === null && states.replay ? "replay"
        : states.reset && app.results !== null ? "reset" : null;

  for (const id of ["capture", "moon", "replay", "reset"]) {
    const button = el(id);
    button.disabled = !states[id];
    button.classList.toggle("primary", id === primary && states[id]);
  }
  el("replay").textContent = app.results === null ? "Run landing replay" : "Replay again";
  el("observation").disabled = !states.capture;
}

/** Overlays are pinned to the canvas markers so DOM and scene stay in step. */
function layoutOverlays() {
  const { w, h } = app.view;
  if (w === 0) return;
  const memory = markerPoint(w, h, "memory");
  const source = markerPoint(w, h, "source");
  const memcard = el("memcard");
  memcard.style.left = `${Math.round(memory.x - 86)}px`;
  memcard.style.top = `${Math.round(memory.y + 46)}px`;
  const sourcecard = el("sourcecard");
  sourcecard.style.left = `${Math.round(source.x - 44)}px`;
  sourcecard.style.top = `${Math.round(source.y + 46)}px`;
}

function markerPoint(w, h, which) {
  return { x: which === "memory" ? w * 0.285 : w * 0.715, y: h * 0.2 };
}

/* ------------------------------------------------------- scene: caches */

const caches = new Map();

function cached(key, width, height, paint) {
  const full = `${key}|${width}x${height}`;
  const hit = caches.get(full);
  if (hit !== undefined) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  paint(canvas.getContext("2d"), canvas.width, canvas.height);
  caches.set(full, canvas);
  return canvas;
}

/* --------------------------------------------------------- scene: stars */

/** Three depth layers so a camera move separates them into real parallax. */
function starLayer(w, h, depth) {
  return cached(`stars${depth}`, w, h, (ctx, cw, ch) => {
    const rng = makeRng(9173 + depth * 4409);
    const count = [220, 110, 46][depth];
    const maxRadius = [0.65, 1.0, 1.5][depth];
    const brightness = [0.35, 0.6, 0.95][depth];
    for (let i = 0; i < count; i += 1) {
      const x = rng() * cw;
      const y = rng() * ch * 0.82;
      const r = 0.28 + rng() * maxRadius;
      const a = brightness * (0.35 + rng() * 0.65);
      const warm = rng();
      ctx.fillStyle = warm > 0.86
        ? `rgba(190,214,255,${a})`
        : warm < 0.08 ? `rgba(255,232,206,${a})` : `rgba(236,242,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (depth === 2 && rng() > 0.72) {
        ctx.strokeStyle = `rgba(226,238,255,${a * 0.45})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - r * 3.4, y); ctx.lineTo(x + r * 3.4, y);
        ctx.moveTo(x, y - r * 3.4); ctx.lineTo(x, y + r * 3.4);
        ctx.stroke();
      }
    }
  });
}

function paintStars(ctx, w, h, alpha, parallax, now) {
  if (alpha <= 0.004) return;
  for (let depth = 0; depth < 3; depth += 1) {
    const shift = parallax * (depth + 1) * 9;
    const twinkle = reduceMotion.matches ? 1 : 0.9 + 0.1 * Math.sin(now / 900 + depth * 2.1);
    ctx.globalAlpha = alpha * twinkle;
    ctx.drawImage(starLayer(w, h, depth), 0, shift);
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------- scene: terrain */

/** Summed seeded sines: a repeatable ridge line without a noise table. */
function ridgeProfile(seed, octaves) {
  const rng = makeRng(seed);
  const waves = [];
  for (let i = 0; i < octaves; i += 1) {
    waves.push({
      frequency: (1 + i * 1.9) * (0.8 + rng() * 0.7),
      amplitude: 1 / (i + 1.35),
      phase: rng() * Math.PI * 2,
    });
  }
  return (x01) => waves.reduce((sum, wave) => sum + wave.amplitude * Math.sin(x01 * Math.PI * 2 * wave.frequency + wave.phase), 0);
}

/**
 * One cratered ground layer: silhouette, sun-side rim light, crater bowls with
 * a lit upper rim and a shadowed floor, scattered rocks, regolith speckle.
 */
function paintTerrainLayer(ctx, w, h, spec) {
  const profile = ridgeProfile(spec.seed, spec.octaves);
  const rng = makeRng(spec.seed + 77);
  const top = (x) => spec.baseY + profile(x / w) * spec.amplitude;

  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, top(0));
  for (let x = 0; x <= w; x += 3) ctx.lineTo(x, top(x));
  ctx.lineTo(w, h);
  ctx.closePath();

  const fill = ctx.createLinearGradient(0, spec.baseY - spec.amplitude, 0, h);
  fill.addColorStop(0, spec.top);
  fill.addColorStop(1, spec.bottom);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);

  /* Craters live inside the clip so they never spill past the silhouette. */
  const craters = Math.round(spec.craters);
  for (let i = 0; i < craters; i += 1) {
    const cx = rng() * w;
    const surface = top(cx);
    const r = spec.craterRadius * (0.35 + rng() * 1.0);
    const cy = surface + r * (0.35 + rng() * 2.6);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${0.24 + rng() * 0.16})`;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, cy - r * 0.07, r * 0.98, r * 0.4, 0, Math.PI * 1.06, Math.PI * 1.94);
    ctx.strokeStyle = `rgba(226,232,246,${0.05 + rng() * 0.07})`;
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.1, r * 0.72, r * 0.26, 0, Math.PI * 0.08, Math.PI * 0.92);
    ctx.strokeStyle = `rgba(0,0,0,${0.2 + rng() * 0.14})`;
    ctx.stroke();
  }

  /* Regolith speckle: enough grain that the ground is not a flat fill. */
  for (let i = 0; i < spec.speckle; i += 1) {
    const x = rng() * w;
    const y = top(x) + rng() * (h - top(x));
    const light = rng() > 0.55;
    ctx.fillStyle = light ? `rgba(214,222,240,${0.02 + rng() * 0.05})` : `rgba(0,0,0,${0.05 + rng() * 0.12})`;
    ctx.fillRect(x, y, 1 + rng() * 1.6, 1 + rng() * 1.2);
  }

  if (spec.rocks > 0) {
    for (let i = 0; i < spec.rocks; i += 1) {
      const x = rng() * w;
      const surface = top(x);
      const y = surface + rng() * (h - surface) * 0.75;
      const r = 1.6 + rng() * 4.4;
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x - r * 0.4, y - r * 0.85);
      ctx.lineTo(x + r * 0.55, y - r * 0.6);
      ctx.lineTo(x + r, y);
      ctx.closePath();
      ctx.fillStyle = `rgba(9,10,16,${0.55 + rng() * 0.3})`;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - r * 0.4, y - r * 0.85);
      ctx.lineTo(x + r * 0.55, y - r * 0.6);
      ctx.strokeStyle = `rgba(206,216,238,${0.07 + rng() * 0.09})`;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
  }
  ctx.restore();

  /* Sun-side rim light along the ridge, falling off to the right. */
  const rim = ctx.createLinearGradient(0, 0, w, 0);
  rim.addColorStop(0, spec.rim);
  rim.addColorStop(0.55, spec.rim.replace(/[\d.]+\)$/, "0.06)"));
  rim.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(0, top(0));
  for (let x = 0; x <= w; x += 3) ctx.lineTo(x, top(x));
  ctx.strokeStyle = rim;
  ctx.lineWidth = spec.rimWidth;
  ctx.stroke();
}

function moonGround(w, h, seed) {
  return cached(`moon${seed}`, w, h, (ctx, cw, ch) => {
    paintTerrainLayer(ctx, cw, ch, {
      seed: seed + 11, baseY: ch * 0.585, amplitude: ch * 0.040, octaves: 4,
      top: "#0b0c14", bottom: "#07080e", craters: 16, craterRadius: cw * 0.020,
      speckle: 260, rocks: 0, rim: "rgba(150,176,222,0.22)", rimWidth: 1,
    });
    paintTerrainLayer(ctx, cw, ch, {
      seed: seed + 29, baseY: ch * 0.705, amplitude: ch * 0.050, octaves: 5,
      top: "#171823", bottom: "#0d0e15", craters: 24, craterRadius: cw * 0.028,
      speckle: 420, rocks: 14, rim: "rgba(178,198,238,0.28)", rimWidth: 1.15,
    });
    paintTerrainLayer(ctx, cw, ch, {
      seed: seed + 53, baseY: ch * GROUND, amplitude: ch * 0.030, octaves: 6,
      top: "#282935", bottom: "#16171f", craters: 26, craterRadius: cw * 0.034,
      speckle: 620, rocks: 30, rim: "rgba(206,222,255,0.34)", rimWidth: 1.3,
    });
  });
}

function earthGround(w, h) {
  return cached("earth", w, h, (ctx, cw, ch) => {
    /* Seen from altitude: a planet limb, its atmosphere lit from behind. */
    const radius = cw * 1.02;
    const cx = cw / 2;
    const cy = ch * 0.80 + radius;

    const halo = ctx.createRadialGradient(cx, cy, radius * 0.965, cx, cy, radius * 1.10);
    halo.addColorStop(0, "rgba(96,165,250,0.00)");
    halo.addColorStop(0.36, "rgba(96,165,250,0.40)");
    halo.addColorStop(0.62, "rgba(90,235,212,0.18)");
    halo.addColorStop(1, "rgba(12,20,42,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    const body = ctx.createLinearGradient(0, ch * 0.76, 0, ch);
    body.addColorStop(0, "#123a58");
    body.addColorStop(0.42, "#0d2740");
    body.addColorStop(1, "#071624");
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, cw, ch);

    /* Cloud decks: soft, low-contrast, parallel to the limb. */
    const rng = makeRng(4801);
    for (let i = 0; i < 26; i += 1) {
      const x = rng() * cw;
      const y = ch * 0.815 + rng() * ch * 0.17;
      const rx = cw * (0.03 + rng() * 0.09);
      ctx.beginPath();
      ctx.ellipse(x, y, rx, rx * (0.07 + rng() * 0.07), 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(178,214,244,${0.03 + rng() * 0.06})`;
      ctx.fill();
    }
    ctx.restore();

    /* Airglow: the bright hairline where the atmosphere meets the void. */
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI * 1.18, Math.PI * 1.82);
    ctx.strokeStyle = "rgba(160,222,255,0.7)";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 5, Math.PI * 1.18, Math.PI * 1.82);
    ctx.strokeStyle = "rgba(96,190,255,0.22)";
    ctx.lineWidth = 10;
    ctx.stroke();
  });
}

/* ------------------------------------------------------------ scene: sky */

function paintSky(ctx, w, h, env) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, mixHex("#050716", "#02030a", env));
  sky.addColorStop(0.52, mixHex("#08182c", "#04050d", env));
  sky.addColorStop(1, mixHex("#0d2d45", "#070810", env));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
}

/** Restrained backlighting: two soft columns rising from behind the horizon. */
function paintBacklight(ctx, w, h, env, accent) {
  const strength = 0.34 - 0.12 * env;
  for (const [cx, scale] of [[w * 0.24, 1], [w * 0.78, 0.78]]) {
    const glow = ctx.createRadialGradient(cx, h * 0.60, 0, cx, h * 0.60, w * 0.32 * scale);
    glow.addColorStop(0, rgba(accent, 0.12 * strength * scale));
    glow.addColorStop(0.5, rgba(accent, 0.04 * strength * scale));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }
}

/** The Earth, small and low in the lunar sky. The only warm-cool contrast. */
function paintDistantEarth(ctx, w, h, alpha) {
  if (alpha <= 0.01) return;
  const x = w * 0.845;
  const y = h * 0.185;
  const r = Math.max(14, Math.min(w, h) * 0.028);
  ctx.save();
  ctx.globalAlpha = alpha;
  const halo = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 5);
  halo.addColorStop(0, "rgba(96,165,250,0.16)");
  halo.addColorStop(1, "rgba(96,165,250,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#060a18";
  ctx.fill();
  /* Lit crescent, cut by an offset disc so the terminator stays clean. */
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  const lit = ctx.createLinearGradient(x - r, y, x + r, y);
  lit.addColorStop(0, "rgba(148,204,255,0.92)");
  lit.addColorStop(0.5, "rgba(74,142,206,0.7)");
  lit.addColorStop(1, "rgba(20,44,86,0.2)");
  ctx.fillStyle = lit;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(x + r * 0.62, y - r * 0.14, r * 0.96, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function mixHex(a, b, k) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(lerp((pa >> shift) & 255, (pb >> shift) & 255, k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/**
 * One full environment frame, Earth and Moon cross-dissolved by `env`.
 * `squash` compresses the ground toward the frame floor so a camera pulling
 * back reads as the surface receding.
 */
function paintEnvironment(ctx, w, h, env, options) {
  const { parallax = 0, squash = 1, now = 0, accent = TEAL, showEarth = true } = options ?? {};
  paintSky(ctx, w, h, env);
  paintStars(ctx, w, h, Math.pow(env, 0.75), parallax, now);
  if (showEarth) paintDistantEarth(ctx, w, h, Math.max(0, env * 0.9 - 0.1));
  paintBacklight(ctx, w, h, env, accent);

  ctx.save();
  if (squash !== 1) {
    ctx.translate(0, h);
    ctx.scale(1, squash);
    ctx.translate(0, -h);
  }
  if (env < 0.999) {
    ctx.globalAlpha = 1 - env;
    ctx.drawImage(earthGround(w, h), 0, 0);
  }
  if (env > 0.001) {
    ctx.globalAlpha = env;
    ctx.drawImage(moonGround(w, h, options?.seed ?? 101), 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  /* Ground haze: thick and blue on Earth, a bare dust glow on the Moon. */
  const horizon = h * (1 - (1 - 0.585) * squash);
  const haze = ctx.createLinearGradient(0, horizon - h * 0.10, 0, h);
  haze.addColorStop(0, "rgba(0,0,0,0)");
  haze.addColorStop(0.5, `rgba(${lerp(70, 26, env) | 0},${lerp(140, 30, env) | 0},${lerp(190, 44, env) | 0},${lerp(0.16, 0.05, env)})`);
  haze.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - h * 0.1, w, h - horizon + h * 0.1);
}

/* ------------------------------------------------------------- the craft

   Drawn at a nominal 100px height in local units and scaled by the caller, so
   the same silhouette reads at hover scale and at long-range scale. */

function drawLander(ctx, x, y, scale, accent, thrust, options) {
  const { flameSeed = 0, now = 0, dead = false } = options ?? {};
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (!dead) drawPlume(ctx, thrust, accent, flameSeed, now);

  const shell = "#1b1d26";
  const lit = "#333743";
  const dark = "#101219";

  /* Landing gear: two forward legs and their struts, drawn behind the hull. */
  ctx.strokeStyle = "#2b2f3b";
  ctx.lineWidth = 3.2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 24, 18);
    ctx.lineTo(side * 46, 47);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(side * 15, 23);
    ctx.lineTo(side * 40, 41);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(side * 47, 48, 7, 2.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#2f3441";
    ctx.fill();
    ctx.strokeStyle = "rgba(206,220,248,0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = "#2b2f3b";
    ctx.lineWidth = 3.2;
  }

  /* Engine bell. */
  ctx.beginPath();
  ctx.moveTo(-8, 20);
  ctx.lineTo(-15, 41);
  ctx.lineTo(15, 41);
  ctx.lineTo(8, 20);
  ctx.closePath();
  const bell = ctx.createLinearGradient(0, 20, 0, 41);
  bell.addColorStop(0, "#2a2e3a");
  bell.addColorStop(1, "#0e1017");
  ctx.fillStyle = bell;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 41, 15, 3.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0c12";
  ctx.fill();
  ctx.strokeStyle = "rgba(214,226,252,0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();

  /* Descent stage: an octagonal foil-wrapped box. */
  ctx.beginPath();
  ctx.moveTo(-30, -4); ctx.lineTo(-22, -12); ctx.lineTo(22, -12); ctx.lineTo(30, -4);
  ctx.lineTo(30, 12); ctx.lineTo(22, 20); ctx.lineTo(-22, 20); ctx.lineTo(-30, 12);
  ctx.closePath();
  const hull = ctx.createLinearGradient(-30, -12, 30, 20);
  hull.addColorStop(0, lit);
  hull.addColorStop(0.45, shell);
  hull.addColorStop(1, dark);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = "rgba(10,12,18,0.9)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  /* Foil banding. */
  ctx.strokeStyle = "rgba(196,208,236,0.09)";
  ctx.lineWidth = 1;
  for (const yy of [-6, 1, 8, 15]) {
    ctx.beginPath();
    ctx.moveTo(-28, yy); ctx.lineTo(28, yy);
    ctx.stroke();
  }

  /* Ascent cap. */
  ctx.beginPath();
  ctx.moveTo(-19, -12); ctx.lineTo(-15, -31); ctx.lineTo(14, -34); ctx.lineTo(20, -12);
  ctx.closePath();
  const cap = ctx.createLinearGradient(-19, -34, 20, -12);
  cap.addColorStop(0, "#3b404e");
  cap.addColorStop(1, "#191b23");
  ctx.fillStyle = cap;
  ctx.fill();
  ctx.strokeStyle = "rgba(10,12,18,0.9)";
  ctx.stroke();

  /* Window: the one warm interior light, tinted by the pane's accent. */
  ctx.beginPath();
  ctx.moveTo(-11, -27); ctx.lineTo(-2, -28.5); ctx.lineTo(-2, -20); ctx.lineTo(-11, -19);
  ctx.closePath();
  ctx.fillStyle = rgba(accent, 0.55);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.85);
  ctx.lineWidth = 0.9;
  ctx.stroke();

  /* Antenna mast and dish. */
  ctx.strokeStyle = "#3a3f4d";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(9, -33); ctx.lineTo(13, -52);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(14, -54, 6, 3.2, -0.35, 0, Math.PI * 2);
  ctx.fillStyle = "#262a35";
  ctx.fill();
  ctx.strokeStyle = "rgba(206,220,248,0.2)";
  ctx.lineWidth = 0.9;
  ctx.stroke();

  /* RCS quads. */
  ctx.fillStyle = "#2c313d";
  for (const side of [-1, 1]) ctx.fillRect(side * 30 - (side < 0 ? 4 : 0), -8, 4, 6);

  /* Rim light: the craft catches the state's accent on its lit edge. */
  ctx.strokeStyle = rgba(accent, dead ? 0.16 : 0.42);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-30, 12); ctx.lineTo(-30, -4); ctx.lineTo(-22, -12); ctx.lineTo(-19, -12); ctx.lineTo(-15, -31);
  ctx.stroke();

  /* Beacon. */
  const beaconOn = reduceMotion.matches ? true : Math.sin(now / 260 + flameSeed) > 0.2;
  if (!dead && beaconOn) {
    ctx.beginPath();
    ctx.arc(-15, -33, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = rgba(accent, 0.95);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-15, -33, 6, 0, Math.PI * 2);
    ctx.fillStyle = rgba(accent, 0.13);
    ctx.fill();
  }

  ctx.restore();
}

/** Plume length and opacity come straight from the sample's thrust value. */
function drawPlume(ctx, thrust, accent, seed, now) {
  if (!(thrust > 0.005)) return;
  const flicker = reduceMotion.matches ? 1 : 1 + 0.05 * Math.sin(now / 38 + seed * 3.1) + 0.03 * Math.sin(now / 17 + seed);
  const length = (26 + Math.pow(thrust, 0.82) * 150) * flicker;
  const width = 11 + thrust * 7;
  const alpha = clamp(0.28 + thrust * 0.72, 0, 1);

  const glow = ctx.createRadialGradient(0, 42, 2, 0, 42, length * 0.9);
  glow.addColorStop(0, rgba(accent, 0.30 * alpha));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(-length, 42 - length * 0.3, length * 2, length * 1.3);

  ctx.beginPath();
  ctx.moveTo(-width * 1.9, 42);
  ctx.quadraticCurveTo(-width * 0.6, 42 + length * 0.85, 0, 42 + length * 1.24);
  ctx.quadraticCurveTo(width * 0.6, 42 + length * 0.85, width * 1.9, 42);
  ctx.closePath();
  const outer = ctx.createLinearGradient(0, 42, 0, 42 + length * 1.24);
  outer.addColorStop(0, rgba(accent, 0.30 * alpha));
  outer.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = outer;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-width * 0.85, 42);
  ctx.quadraticCurveTo(-width * 0.3, 42 + length * 0.7, 0, 42 + length);
  ctx.quadraticCurveTo(width * 0.3, 42 + length * 0.7, width * 0.85, 42);
  ctx.closePath();
  const core = ctx.createLinearGradient(0, 42, 0, 42 + length);
  core.addColorStop(0, `rgba(255,255,255,${0.9 * alpha})`);
  core.addColorStop(0.32, rgba(accent, 0.75 * alpha));
  core.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = core;
  ctx.fill();

  /* Shock diamonds only appear where the engine is actually near full. */
  if (thrust > 0.5) {
    for (let i = 1; i <= 3; i += 1) {
      const yy = 42 + length * (0.16 * i);
      ctx.beginPath();
      ctx.ellipse(0, yy, width * (0.34 - i * 0.06), length * 0.05, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(0.5 - i * 0.12) * alpha})`;
      ctx.fill();
    }
  }
}

/* --------------------------------------------------------------- dust */

let dustSeed = 1;
function spawnDust(x, groundY, intensity, count) {
  dustSeed = (dustSeed + 6151) >>> 0;
  const rng = makeRng(dustSeed);
  for (let i = 0; i < count; i += 1) {
    const direction = rng() > 0.5 ? 1 : -1;
    /* No atmosphere: grains leave fast and flat and do not billow. */
    app.dust.push({
      x, y: groundY,
      vx: direction * (60 + rng() * 260) * intensity,
      vy: -(10 + rng() * 90) * intensity,
      life: 0,
      span: 0.6 + rng() * 0.8,
      r: 0.7 + rng() * 1.8,
    });
  }
}

function stepDust(dt) {
  for (const grain of app.dust) {
    grain.life += dt;
    grain.x += grain.vx * dt;
    grain.y += grain.vy * dt;
    grain.vy += 150 * dt;
  }
  app.dust = app.dust.filter((grain) => grain.life < grain.span);
  if (app.dust.length > 900) app.dust = app.dust.slice(-900);
}

function paintDust(ctx) {
  for (const grain of app.dust) {
    const alpha = (1 - grain.life / grain.span) * 0.5;
    ctx.fillStyle = `rgba(198,204,222,${alpha})`;
    ctx.beginPath();
    ctx.arc(grain.x, grain.y, grain.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* -------------------------------------------------------------- tether */

function paintTether(ctx, w, h, now, accent) {
  const tether = tetherState(now);
  const memory = markerPoint(w, h, "memory");
  const source = markerPoint(w, h, "source");
  const sag = 34;

  if (tether.mode !== "none" && tether.drawn > 0) {
    const broken = tether.broken ?? 0;
    if (broken <= 0.001) {
      strokeTetherSegment(ctx, memory, source, sag, 0, tether.drawn, accent, 1);
      if (tether.drawn >= 1 && !reduceMotion.matches) paintTetherFlow(ctx, memory, source, sag, now, accent);
    } else {
      const gap = 0.02 + broken * 0.13;
      strokeTetherSegment(ctx, memory, source, sag, 0, 0.5 - gap, accent, 1 - broken * 0.25);
      strokeTetherSegment(ctx, memory, source, sag, 0.5 + gap, 1, accent, 1 - broken * 0.25);
      paintFray(ctx, memory, source, sag, 0.5 - gap, -1, broken, accent);
      paintFray(ctx, memory, source, sag, 0.5 + gap, 1, broken, accent);
      if (broken < 1) paintSnapFlash(ctx, bezierPoint(memory, source, sag, 0.5), broken, accent);
    }
  }

  paintMemoryMarker(ctx, memory, now, accent, tether);
  paintSourceMarker(ctx, source, now, accent, tether);

  ctx.save();
  ctx.font = '500 9.5px ui-monospace, "SF Mono", Menlo, monospace';
  if ("letterSpacing" in ctx) ctx.letterSpacing = "1.6px";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(85,85,106,0.95)";
  ctx.fillText("MEMORY", memory.x, memory.y + 30);
  ctx.fillText("SOURCE", source.x, source.y + 30);
  ctx.restore();
}

function bezierPoint(a, b, sag, t) {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 + sag * 2;
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
    y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
  };
}

function strokeTetherSegment(ctx, a, b, sag, t0, t1, accent, alpha) {
  if (t1 <= t0) return;
  const steps = 60;
  const path = new Path2D();
  for (let i = 0; i <= steps; i += 1) {
    const point = bezierPoint(a, b, sag, lerp(t0, t1, i / steps));
    if (i === 0) path.moveTo(point.x, point.y); else path.lineTo(point.x, point.y);
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = rgba(accent, 0.10 * alpha);
  ctx.lineWidth = 9;
  ctx.stroke(path);
  ctx.strokeStyle = rgba(accent, 0.28 * alpha);
  ctx.lineWidth = 4;
  ctx.stroke(path);
  ctx.strokeStyle = rgba(accent, 0.95 * alpha);
  ctx.lineWidth = 1.5;
  ctx.stroke(path);
}

/** Light travelling memory → source: the tether is doing work. */
function paintTetherFlow(ctx, a, b, sag, now, accent) {
  for (let i = 0; i < 5; i += 1) {
    const t = ((now / 2600) + i / 5) % 1;
    const point = bezierPoint(a, b, sag, t);
    const fade = Math.sin(t * Math.PI);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = rgba(accent, 0.9 * fade);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = rgba(accent, 0.14 * fade);
    ctx.fill();
  }
}

/** Severed ends recoil and fray into loose filaments. */
function paintFray(ctx, a, b, sag, t, direction, broken, accent) {
  const end = bezierPoint(a, b, sag, t);
  const near = bezierPoint(a, b, sag, clamp(t + direction * 0.04, 0, 1));
  const dx = end.x - near.x;
  const dy = end.y - near.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const rng = makeRng(direction > 0 ? 5501 : 8807);
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i += 1) {
    const spread = (rng() - 0.5) * 2.4;
    const reach = (7 + rng() * 15) * broken;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.quadraticCurveTo(
      end.x + ux * reach * 0.6 - uy * spread * 3,
      end.y + uy * reach * 0.6 + ux * spread * 3,
      end.x + ux * reach + uy * spread * 6,
      end.y + uy * reach - ux * spread * 6,
    );
    ctx.strokeStyle = rgba(accent, 0.5 - i * 0.09);
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
}

function paintSnapFlash(ctx, point, broken, accent) {
  const grow = smoothstep(broken);
  const fade = 1 - broken;
  const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 12 + grow * 90);
  glow.addColorStop(0, rgba(accent, 0.75 * fade));
  glow.addColorStop(0.35, rgba(accent, 0.18 * fade));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(point.x - 130, point.y - 130, 260, 260);
}

function paintMemoryMarker(ctx, p, now, accent, tether) {
  const r = 13;
  const empty = tether.mode === "none";
  const quarantine = tether.quarantine ?? 0;
  const pulse = reduceMotion.matches ? 0.5 : 0.5 + 0.5 * Math.sin(now / 780);

  if (!empty) {
    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
    halo.addColorStop(0, rgba(accent, 0.20 + pulse * 0.10));
    halo.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(p.x - r * 4, p.y - r * 4, r * 8, r * 8);
  }

  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const x = p.x + Math.cos(angle) * r;
    const y = p.y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = empty ? "rgba(8,9,16,0.7)" : "rgba(7,10,16,0.92)";
  ctx.fill();
  ctx.setLineDash(empty ? [3, 4] : []);
  ctx.strokeStyle = empty ? "rgba(85,85,106,0.9)" : rgba(accent, 0.9);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  if (!empty) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = rgba(accent, 0.55 + pulse * 0.45);
    ctx.fill();
  }

  /* Quarantine: a slow dashed ring closing around a memory nobody may use. */
  if (quarantine > 0) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (!reduceMotion.matches) ctx.rotate(now / 3400);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = rgba(accent, 0.55 * quarantine);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 9 + (1 - quarantine) * 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }
}

function paintSourceMarker(ctx, p, now, accent, tether) {
  const r = 12;
  const flare = tether.flare ?? 0;
  const lock = tether.lock ?? 0;

  const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
  halo.addColorStop(0, rgba(accent, 0.14 + flare * 0.5));
  halo.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(p.x - r * 4, p.y - r * 4, r * 8, r * 8);

  roundRect(ctx, p.x - r, p.y - r, r * 2, r * 2, 4);
  ctx.fillStyle = "rgba(7,10,16,0.92)";
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.9);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  /* Bracket ticks: this marker is a declaration, not a value. */
  ctx.strokeStyle = rgba(accent, 0.95);
  ctx.lineWidth = 1.6;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(p.x + side * 2.5, p.y - 5);
    ctx.lineTo(p.x + side * 5.5, p.y);
    ctx.lineTo(p.x + side * 2.5, p.y + 5);
    ctx.stroke();
  }

  /* The lock ring contracts onto the marker when a capture takes hold. */
  if (lock > 0 && lock < 1) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 6 + (1 - lock) * 40, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(accent, 0.85 * lock);
    ctx.lineWidth = 1.6;
    ctx.stroke();
  } else if (lock >= 1 && tether.mode === "intact") {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(accent, 0.30);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* -------------------------------------------------------- trajectories */

function sampleTrajectory(trajectory, seconds) {
  const last = trajectory[trajectory.length - 1];
  if (seconds >= last.timeSeconds) return { ...last, done: true };
  let lo = 0;
  let hi = trajectory.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trajectory[mid].timeSeconds <= seconds) lo = mid; else hi = mid;
  }
  const a = trajectory[lo];
  const b = trajectory[hi];
  const span = b.timeSeconds - a.timeSeconds;
  const k = span > 0 ? (seconds - a.timeSeconds) / span : 0;
  return {
    timeSeconds: seconds,
    altitudeMeters: lerp(a.altitudeMeters, b.altitudeMeters, k),
    verticalVelocityMetersPerSecond: lerp(a.verticalVelocityMetersPerSecond, b.verticalVelocityMetersPerSecond, k),
    fuelUnits: lerp(a.fuelUnits, b.fuelUnits, k),
    thrust: lerp(a.thrust, b.thrust, k),
    done: false,
  };
}

const trajectoryEnd = (trajectory) => trajectory[trajectory.length - 1].timeSeconds;

/* ------------------------------------------------------- replay panes */

/**
 * One replay pane. The camera pulls back only where it must: the stale craft
 * outruns its frame, and the zoom-out is capped so it genuinely leaves.
 */
function paintPane(ctx, pane, now) {
  const { x, w, h, run, accent, label, seed, follow, split } = pane;
  const sample = run.sample;
  const baseMeters = Math.max(12, run.trajectory[0].altitudeMeters * 1.3);
  const maxMeters = baseMeters * 3.6;
  const frameMeters = follow ? clamp(sample.altitudeMeters * 1.28, baseMeters, maxMeters) : baseMeters;
  const zoom = baseMeters / frameMeters;

  const groundY = h * GROUND;
  const topY = h * 0.14;
  const pxPerMeter = (groundY - topY) / frameMeters;
  const landerY = groundY - sample.altitudeMeters * pxPerMeter;
  const landerScale = clamp(zoom, 0.3, 1) * (h / 780) * 1.24;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, 0, w, h);
  ctx.clip();
  ctx.translate(x, 0);

  paintEnvironment(ctx, w, h, 1, {
    parallax: (1 - zoom) * 3.4,
    squash: 0.34 + zoom * 0.66,
    now,
    accent,
    seed,
    showEarth: false,
  });

  /* Key light behind the subject: the focus is on the craft, not the frame. */
  const key = ctx.createRadialGradient(w / 2, landerY, 0, w / 2, landerY, w * 0.5);
  key.addColorStop(0, rgba(accent, 0.055));
  key.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  const onScreen = landerY > -60;
  /* The craft slides out of the shared frame into its own pane. */
  const landerX = lerp(app.view.w / 2 - x, w / 2, split);

  if (onScreen) {
    if (sample.altitudeMeters < 22 && !run.dead) {
      const shadowAlpha = 0.4 * (1 - sample.altitudeMeters / 22);
      ctx.beginPath();
      ctx.ellipse(landerX + 16, groundY + 3, 52 * landerScale, 8 * landerScale, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
      ctx.fill();
    }
    drawLander(ctx, landerX, landerY, landerScale, accent, run.dead ? 0 : sample.thrust, {
      flameSeed: seed,
      now,
      dead: run.dead,
    });
  } else {
    paintOffFrameMarker(ctx, landerX, accent, sample, now, run.dead);
  }

  if (pane.dust) paintDust(ctx);
  if (pane.pulse !== null) paintLandingPulse(ctx, landerX, groundY, pane.pulse);

  paintPaneLabel(ctx, w, label, accent, sample, run);
  ctx.restore();
}

/** The craft is gone from frame but the numbers keep coming. */
function paintOffFrameMarker(ctx, x, accent, sample, now, dead) {
  const bob = reduceMotion.matches ? 0 : Math.sin(now / 420) * 2;
  const y = 124 + bob;
  const beam = ctx.createLinearGradient(x, y - 30, x, y + 70);
  beam.addColorStop(0, rgba(accent, 0.26));
  beam.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = beam;
  ctx.fillRect(x - 22, y - 30, 44, 100);

  ctx.strokeStyle = rgba(accent, 0.95);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 9, y + 8);
  ctx.lineTo(x, y - 2);
  ctx.lineTo(x + 9, y + 8);
  ctx.stroke();

  if (dead) return;
  ctx.save();
  ctx.font = '500 11px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.textAlign = "center";
  ctx.fillStyle = rgba(accent, 0.9);
  ctx.fillText("climbing out of frame", x, y + 28);
  ctx.restore();
}

function paintLandingPulse(ctx, x, groundY, progress) {
  const grow = smoothstep(clamp(progress, 0, 1));
  const fade = 1 - clamp(progress, 0, 1);
  ctx.strokeStyle = rgba(GREEN, 0.7 * fade);
  ctx.lineWidth = 2 - grow;
  ctx.beginPath();
  ctx.ellipse(x, groundY, 30 + grow * 210, (30 + grow * 210) * 0.22, 0, 0, Math.PI * 2);
  ctx.stroke();
  const glow = ctx.createRadialGradient(x, groundY, 0, x, groundY, 160);
  glow.addColorStop(0, rgba(GREEN, 0.16 * fade));
  glow.addColorStop(1, rgba(GREEN, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - 170, groundY - 90, 340, 180);
}

function paintPaneLabel(ctx, w, label, accent, sample, run) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
  if ("letterSpacing" in ctx) ctx.letterSpacing = "2.4px";
  ctx.fillStyle = rgba(accent, 0.92);
  ctx.fillText(label, w / 2, 34);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  ctx.strokeStyle = rgba(accent, 0.22);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 118, 44);
  ctx.lineTo(w / 2 + 118, 44);
  ctx.stroke();

  ctx.font = '400 11px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.fillStyle = "rgba(136,136,160,0.95)";
  ctx.fillText(
    `alt ${sample.altitudeMeters.toFixed(1)} m   v ${signed(sample.verticalVelocityMetersPerSecond)} m/s   fuel ${sample.fuelUnits.toFixed(2)}`,
    w / 2,
    62,
  );
  if (run.dead) {
    ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = rgba(run.outcome === "soft_landing" ? GREEN : ORANGE, 0.95);
    ctx.fillText(outcomeLabel(run.outcome).toUpperCase(), w / 2, 82);
  }
  ctx.restore();
}

function paintDivider(ctx, w, h, alpha) {
  const line = ctx.createLinearGradient(0, 0, 0, h);
  line.addColorStop(0, "rgba(255,255,255,0)");
  line.addColorStop(0.16, `rgba(255,255,255,${0.09 * alpha})`);
  line.addColorStop(0.46, `rgba(255,255,255,${0.17 * alpha})`);
  line.addColorStop(0.76, `rgba(255,255,255,${0.06 * alpha})`);
  line.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = line;
  ctx.fillRect(w / 2 - 0.5, 0, 1, h);
}

/* --------------------------------------------------------- frame loop */

let lastFrame = 0;

function paintFrame(now) {
  const { w, h } = app.view;
  if (w === 0 || app.mission === null) return;
  const dt = lastFrame === 0 ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  CTX.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  CTX.clearRect(0, 0, w, h);

  if (app.phase === "replay") paintReplay(now, dt);
  else paintStandby(now);
}

function paintStandby(now) {
  const { w, h } = app.view;
  const env = envValue(now);
  const accent = env > 0.5 ? AMBER : TEAL;

  paintEnvironment(CTX, w, h, env, { now, accent, seed: 101, parallax: 0 });

  /* A light sweep sells the moment the world itself changes underfoot. */
  const migrate = cueAt("migrate", now);
  if (migrate !== null && migrate < 0.7) {
    const k = sub(migrate, 0.1, 0.7);
    const sweep = CTX.createLinearGradient(0, h * (1 - k) - 200, 0, h * (1 - k) + 60);
    sweep.addColorStop(0, "rgba(255,255,255,0)");
    sweep.addColorStop(0.7, `rgba(210,230,255,${0.09 * Math.sin(k * Math.PI)})`);
    sweep.addColorStop(1, "rgba(255,255,255,0)");
    CTX.fillStyle = sweep;
    CTX.fillRect(0, 0, w, h);
  }

  const groundY = h * GROUND;
  const bob = reduceMotion.matches ? 0 : Math.sin(now / 1650) * 5;
  const scale = (h / 780) * 1.32;
  drawLander(CTX, w / 2, groundY - h * 0.235 + bob, scale, accent, 0.13, { flameSeed: 3, now });

  paintTether(CTX, w, h, now, accent);
}

function paintReplay(now, dt) {
  const { w, h } = app.view;
  const replay = app.replay;
  const lander = app.mission.lander;
  const progress = reduceMotion.matches ? 1 : clamp((now - replay.start) / REPLAY_MS, 0, 1);
  const seconds = progress * replay.simSeconds;
  const split = reduceMotion.matches ? 1 : smoothstep(clamp((now - replay.start) / 620, 0, 1));

  const stale = buildRun(lander.stale, seconds);
  const good = buildRun(lander.revalidated, seconds);

  /* Dust and the landing pulse are driven by the real descent, not a timer. */
  const groundY = h * GROUND;
  const touchdownX = w / 4;
  if (!reduceMotion.matches) {
    if (!good.dead && good.sample.altitudeMeters < 7 && good.sample.thrust > 0.02) {
      spawnDust(touchdownX, groundY, 0.5 + (7 - good.sample.altitudeMeters) / 7, 3);
    }
    if (good.dead && app.pulse === null) {
      app.pulse = { start: now };
      spawnDust(touchdownX, groundY, 1.4, 90);
    }
    stepDust(dt);
  }
  const pulse = app.pulse === null ? null : (now - app.pulse.start) / 1200;

  paintPane(CTX, {
    x: 0, w: w / 2, h, run: stale, accent: AMBER, label: "STALE MEMORY",
    seed: 101, follow: true, split, dust: false, pulse: null,
  }, now);
  paintPane(CTX, {
    x: w / 2, w: w / 2, h, run: good, accent: TEAL, label: "REVALIDATED SOURCE",
    seed: 307, follow: false, split, dust: true, pulse: pulse !== null && pulse < 1 ? pulse : null,
  }, now);

  paintDivider(CTX, w, h, split);

  if (progress >= 1 && !reduceMotion.matches) settleReplay();
}

function buildRun(result, seconds) {
  const sample = sampleTrajectory(result.trajectory, seconds);
  return {
    trajectory: result.trajectory,
    outcome: result.outcome,
    sample,
    dead: seconds >= trajectoryEnd(result.trajectory),
  };
}

function loop(now) {
  paintFrame(now);
  if (!reduceMotion.matches) requestAnimationFrame(loop);
}

/* ------------------------------------------------------------- actions */

function resizeCanvas() {
  const rect = STAGE.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  app.view = { w: Math.round(rect.width), h: Math.round(rect.height) };
  app.dpr = dpr;
  CANVAS.width = Math.round(rect.width * dpr);
  CANVAS.height = Math.round(rect.height * dpr);
  caches.clear();
  layoutOverlays();
  if (reduceMotion.matches) paintFrame(performance.now());
}

function applyState(next, options) {
  app.mission = next;
  if (options?.keepResults !== true) {
    app.results = null;
    app.replay = null;
    app.dust = [];
    app.pulse = null;
  }
  const phase = missionPhase(next);
  const envTo = next.calibration === "lunar" ? 1 : 0;
  if (envTo !== app.envTo) {
    app.envFrom = app.envTo;
    app.envTo = envTo;
    if (options?.cue !== "migrate") cue("env", ENV_MS);
  }
  app.phase = phase;
  renderChrome();
  if (reduceMotion.matches) paintFrame(performance.now());
}

function showError(error) {
  const node = el("error");
  node.hidden = error === undefined;
  node.textContent = error === undefined ? "" : `system / ${error.message ?? error}`;
}

async function run(action, after) {
  if (app.busy) return;
  app.busy = true;
  renderActions();
  try {
    showError();
    const next = await action();
    after?.(next);
  } catch (error) {
    showError(error);
  } finally {
    app.busy = false;
    renderActions();
  }
}

function startReplay() {
  if (!canReplay(app.mission)) return;
  const lander = app.mission.lander;
  app.replay = {
    start: performance.now(),
    simSeconds: Math.max(trajectoryEnd(lander.stale.trajectory), trajectoryEnd(lander.revalidated.trajectory)),
  };
  app.results = null;
  app.dust = [];
  app.pulse = null;
  app.phase = "replay";
  renderChrome();

  if (reduceMotion.matches) {
    /* One still frame at the terminal state, then back to the withheld
       frame with the outcomes. No animation runs at any point. */
    paintFrame(performance.now());
    setTimeout(settleReplay, SETTLE_STATIC_MS);
  }
}

function settleReplay() {
  if (app.phase !== "replay") return;
  const lander = app.mission.lander;
  app.results = {
    stale: { outcome: lander.stale.outcome, finalState: lander.stale.finalState },
    revalidated: { outcome: lander.revalidated.outcome, finalState: lander.revalidated.finalState },
  };
  app.replay = null;
  app.dust = [];
  app.pulse = null;
  app.phase = missionPhase(app.mission) === "lunar" ? "settled" : missionPhase(app.mission);
  document.body.dataset.phase = app.phase;
  renderChrome();
  if (reduceMotion.matches) paintFrame(performance.now());
}

/* Chromium is the only engine that runs an SVG filter as a backdrop filter.
   The map is mid-grey through the middle and ramps outward, so a pane stays
   optically flat where its text sits and bends only in a band at the rim. */
function installRefraction() {
  const size = 192;
  const band = 0.30;
  const source = document.createElement("canvas");
  source.width = size;
  source.height = size;
  const ctx = source.getContext("2d");
  if (ctx === null) return;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const edgeX = Math.min(u, 1 - u);
      const edgeY = Math.min(v, 1 - v);
      const rampX = edgeX < band ? 1 - edgeX / band : 0;
      const rampY = edgeY < band ? 1 - edgeY / band : 0;
      const dx = (u < 0.5 ? -1 : 1) * Math.pow(rampX, 1.7);
      const dy = (v < 0.5 ? -1 : 1) * Math.pow(rampY, 1.7);
      const index = (y * size + x) * 4;
      image.data[index] = clamp(128 + dx * 127, 0, 255);
      image.data[index + 1] = clamp(128 + dy * 127, 0, 255);
      image.data[index + 2] = 128;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  el("glass-filters").innerHTML =
    `<filter id="liquid-glass-refraction" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
       <feImage href="${source.toDataURL("image/png")}" preserveAspectRatio="none" result="map"/>
       <feDisplacementMap in="SourceGraphic" in2="map" scale="88" xChannelSelector="R" yChannelSelector="G"/>
     </filter>`;
}

/* ------------------------------------------------------------- wiring */

el("capture").onclick = () => run(
  () => api("/api/capture", { observationId: el("observation").value.trim() }),
  (next) => {
    applyState(next);
    if (app.phase === "earth") cue("capture", CAPTURE_MS);
  },
);

el("moon").onclick = () => run(
  () => api("/api/calibration", { mode: "lunar" }),
  (next) => {
    /* The tether only parts after the API has actually reported divergence. */
    if (isLunarWithheld(next)) {
      app.envFrom = app.envTo;
      app.envTo = 1;
      cue("migrate", MIGRATE_MS);
      applyState(next, { cue: "migrate" });
    } else {
      applyState(next);
    }
  },
);

el("replay").onclick = () => startReplay();

el("reset").onclick = () => run(
  () => api("/api/reset", {}),
  (next) => {
    app.cues.clear();
    app.results = null;
    app.replay = null;
    app.dust = [];
    app.pulse = null;
    applyState(next);
  },
);

el("observation").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !el("capture").disabled) el("capture").click();
});

addEventListener("resize", resizeCanvas);
reduceMotion.addEventListener("change", () => {
  lastFrame = 0;
  if (!reduceMotion.matches) requestAnimationFrame(loop);
  else paintFrame(performance.now());
});

installRefraction();
if (HOSTED_GUIDED_DEMO) {
  el("hosted-note").hidden = false;
  el("observation-control").hidden = true;
}
resizeCanvas();
renderChrome();
if (!reduceMotion.matches) requestAnimationFrame(loop);

api("/api/state")
  .then((next) => applyState(next))
  .catch(showError);
