/**
 * Stochastic leeway drift model — pure math, no Cesium/DOM/network.
 *
 * Formulation (Breivik & Allen 2008): a drifting object moves with the
 * surface current plus a leeway response to the 10 m wind, split into a
 * downwind component and a signed crosswind component. Each component is
 * linear in wind speed, L = (slope/100)·W10 + offset/100 [m/s], with a
 * per-particle Gaussian perturbation whose scale is the taxonomy's
 * regression standard error, and the crosswind sign flips through rare
 * "jibing" events at an exponential rate.
 *
 * Coefficients: USCG leeway taxonomy, PIW-1 "Person-in-water, unknown
 * state (mean values)" — transcribed 2026-08-28 from the OBJECTPROP table
 * distributed with met.no's OpenDrift Leeway model (values originally from
 * Allen & Plourde 1999 and Allen 2005):
 *   downwind  slope 0.96 % of W10, offset 0 cm/s, std error 12.0 cm/s
 *   crosswind slope ±0.54 %,       offset 0 cm/s, std error  9.4 cm/s
 *   jibing    0.04 / hour (OpenDrift default), applied per step as
 *             p = 1 − exp(−λ·Δt), λ = −ln(1 − rate)/3600 s⁻¹
 *
 * Sources:
 * - Allen, A.A. & J.V. Plourde (1999): Review of Leeway: Field Experiments
 *   and Implementation. USCG R&D Center report CG-D-08-99.
 * - Allen, A.A. (2005): Leeway Divergence. USCG R&D Center CG-D-05-05.
 * - Breivik, Ø. & A.A. Allen (2008): An operational search and rescue model
 *   for the Norwegian Sea and the North Sea. J. Marine Systems 69(1-2).
 * - OpenDrift Leeway model (met.no), OBJECTPROP.DAT + leeway.py — the
 *   machine-readable taxonomy and the per-step jibe formula mirrored here.
 *
 * Time integration is forward Euler over forecast fields interpolated
 * bilinearly in space and linearly in time — appropriate here because
 * forcing-field uncertainty dominates integration error at 5–10 min steps.
 */

export const EARTH_RADIUS_M = 6371000;

const DEG = Math.PI / 180;

export const LEEWAY_CLASSES = Object.freeze({
  PIW: Object.freeze({
    label: 'Person in water (unknown state)',
    downwind: Object.freeze({ slopePct: 0.96, offsetCms: 0, stdCms: 12.0 }),
    crosswind: Object.freeze({ slopePct: 0.54, offsetCms: 0, stdCms: 9.4 }),
    jibeRatePerHour: 0.04,
  }),
});

/**
 * Deterministic 32-bit RNG (mulberry32). Same seed → same stream, across
 * main thread and worker.
 * @param {number} seed - Any finite number; hashed to 32 bits.
 * @returns {() => number} Uniform [0, 1) generator.
 */
export function makeRng(seed) {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller) from a uniform generator. */
export function randn(rng) {
  let u = 0;
  while (u === 0) u = rng(); // avoid log(0)
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Meteorological direction (FROM, degrees clockwise from north) → east/north
 * velocity components. A wind "from 270°" blows toward the east.
 * @param {number} speedMs - Wind speed, m/s.
 * @param {number} fromDeg - Direction the wind comes FROM.
 * @returns {{u: number, v: number}} East (u) and north (v) components, m/s.
 */
export function metFromDirToUV(speedMs, fromDeg) {
  const toRad = (fromDeg + 180) * DEG;
  return { u: speedMs * Math.sin(toRad), v: speedMs * Math.cos(toRad) };
}

/**
 * Oceanographic direction (TO, degrees clockwise from north) → east/north
 * velocity components. A current "toward 90°" flows east. The wind/current
 * FROM-vs-TO asymmetry is the classic leeway sign bug — it lives in exactly
 * these two functions and nowhere else.
 * @param {number} speedMs - Current speed, m/s.
 * @param {number} toDeg - Direction the current flows TOWARD.
 * @returns {{u: number, v: number}}
 */
export function oceanToDirToUV(speedMs, toDeg) {
  const toRad = toDeg * DEG;
  return { u: speedMs * Math.sin(toRad), v: speedMs * Math.cos(toRad) };
}

/**
 * Per-step jibe probability from an hourly rate: p = 1 − exp(−λ·Δt) with
 * λ = −ln(1 − ratePerHour)/3600 (the OpenDrift formulation).
 * @param {number} ratePerHour - Jibe probability per hour (0 disables).
 * @param {number} dtS - Time step, seconds.
 * @returns {number}
 */
export function perStepJibeProbability(ratePerHour, dtS) {
  if (!(ratePerHour > 0) || !(dtS > 0)) return 0;
  const lambda = -Math.log(1 - Math.min(ratePerHour, 0.999999)) / 3600;
  return 1 - Math.exp(-lambda * dtS);
}

/**
 * Build a forcing sampler over a normalized grid:
 * `{lats, lons, hoursMs, currentU, currentV, windU, windV}` where each field
 * is a flat array of length `hoursMs.length × lats.length × lons.length`,
 * hour-major then lat-major (`field[(t·NLAT + iLat)·NLON + iLon]`).
 *
 * Bilinear in space, linear in time, clamped at the grid edges. NaN values
 * (forecast holes) sample as 0 with `degraded: true` — a gap must never
 * inject NaN into particle positions, and the caller surfaces degradation
 * honestly instead of inventing forcing.
 *
 * @param {Object} grid - Normalized forcing grid.
 * @returns {(lat: number, lon: number, tMs: number) =>
 *   {curU: number, curV: number, windU: number, windV: number, degraded: boolean}}
 */
export function makeForcingSampler(grid) {
  const { lats, lons, hoursMs } = grid;
  const NLAT = lats.length;
  const NLON = lons.length;

  const bracket = (values, x) => {
    if (x <= values[0]) return { i0: 0, i1: 0, w: 0 };
    const last = values.length - 1;
    if (x >= values[last]) return { i0: last, i1: last, w: 0 };
    let i = 0;
    while (values[i + 1] < x) i += 1;
    const span = values[i + 1] - values[i];
    return { i0: i, i1: i + 1, w: span > 0 ? (x - values[i]) / span : 0 };
  };

  return (lat, lon, tMs) => {
    const bLat = bracket(lats, lat);
    const bLon = bracket(lons, lon);
    const bT = bracket(hoursMs, tMs);
    let degraded = false;

    const cell = (field, t, iLat, iLon) => {
      const value = field[(t * NLAT + iLat) * NLON + iLon];
      if (Number.isFinite(value)) return value;
      degraded = true;
      return 0;
    };
    const bilinear = (field, t) => {
      const v00 = cell(field, t, bLat.i0, bLon.i0);
      const v01 = cell(field, t, bLat.i0, bLon.i1);
      const v10 = cell(field, t, bLat.i1, bLon.i0);
      const v11 = cell(field, t, bLat.i1, bLon.i1);
      const v0 = v00 + (v01 - v00) * bLon.w;
      const v1 = v10 + (v11 - v10) * bLon.w;
      return v0 + (v1 - v0) * bLat.w;
    };
    const sample = (field) => {
      const early = bilinear(field, bT.i0);
      if (bT.i0 === bT.i1) return early;
      return early + (bilinear(field, bT.i1) - early) * bT.w;
    };

    return {
      curU: sample(grid.currentU),
      curV: sample(grid.currentV),
      windU: sample(grid.windU),
      windV: sample(grid.windV),
      degraded,
    };
  };
}

/**
 * Run a full leeway Monte Carlo ensemble.
 *
 * Per particle, seeded once: an initial position scatter (`posSigmaM`),
 * additive downwind/crosswind velocity residuals ~N(0, stdCms/100), and a
 * 50/50 crosswind sign that may jibe each step. Per step: velocity =
 * current + downwind leeway along the wind unit vector + signed crosswind
 * leeway along its right-perpendicular, advanced on the sphere.
 *
 * @param {Object} options
 * @param {number} options.n Particle count.
 * @param {number} options.seedLat Seed latitude, degrees.
 * @param {number} options.seedLon Seed longitude, degrees.
 * @param {number} options.startTimeMs Epoch ms of the drift start.
 * @param {number} options.horizonH Simulation horizon, hours.
 * @param {number} options.dtMin Time step, minutes.
 * @param {Object} options.grid Normalized forcing grid (makeForcingSampler).
 * @param {number} options.rngSeed Deterministic ensemble seed.
 * @param {string} [options.cls='PIW'] Leeway class key.
 * @param {Object} [options.classOverrides] Test/tuning overrides merged onto the class.
 * @param {number} [options.posSigmaM=100] Initial position scatter, meters.
 * @returns {{timesMs: Float64Array, frames: Float32Array, n: number, degraded: boolean}}
 *   `frames` is frame-major `[lon, lat]` pairs: `frames[(t·n + i)·2]` = lon.
 */
export function runEnsemble({
  n,
  seedLat,
  seedLon,
  startTimeMs,
  horizonH,
  dtMin,
  grid,
  rngSeed,
  cls = 'PIW',
  classOverrides = null,
  posSigmaM = 100,
}) {
  const base = LEEWAY_CLASSES[cls] ?? LEEWAY_CLASSES.PIW;
  const config = classOverrides ? { ...base, ...classOverrides } : base;
  const rng = makeRng(rngSeed);
  const sampler = makeForcingSampler(grid);

  const dtS = dtMin * 60;
  const steps = Math.max(1, Math.round((horizonH * 3600) / dtS));
  const jibeP = perStepJibeProbability(config.jibeRatePerHour, dtS);

  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const downEps = new Float64Array(n);
  const crossEps = new Float64Array(n);
  const crossSign = new Float64Array(n);

  const scatterDeg = posSigmaM / EARTH_RADIUS_M / DEG;
  const cosSeed = Math.cos(seedLat * DEG);
  for (let i = 0; i < n; i += 1) {
    lat[i] = seedLat + randn(rng) * scatterDeg;
    lon[i] = seedLon + (randn(rng) * scatterDeg) / cosSeed;
    downEps[i] = randn(rng) * (config.downwind.stdCms / 100);
    crossEps[i] = randn(rng) * (config.crosswind.stdCms / 100);
    crossSign[i] = rng() < 0.5 ? -1 : 1;
  }

  const timesMs = new Float64Array(steps + 1);
  const frames = new Float32Array((steps + 1) * n * 2);
  let degraded = false;

  const record = (frame) => {
    const offset = frame * n * 2;
    for (let i = 0; i < n; i += 1) {
      frames[offset + i * 2] = lon[i];
      frames[offset + i * 2 + 1] = lat[i];
    }
  };

  timesMs[0] = startTimeMs;
  record(0);

  const downSlope = config.downwind.slopePct / 100;
  const downOffset = config.downwind.offsetCms / 100;
  const crossSlope = config.crosswind.slopePct / 100;
  const crossOffset = config.crosswind.offsetCms / 100;

  for (let step = 1; step <= steps; step += 1) {
    const tMs = startTimeMs + step * dtS * 1000;
    for (let i = 0; i < n; i += 1) {
      const forcing = sampler(lat[i], lon[i], tMs);
      if (forcing.degraded) degraded = true;

      let vE = forcing.curU;
      let vN = forcing.curV;
      const windSpeed = Math.hypot(forcing.windU, forcing.windV);
      if (windSpeed > 0) {
        const wU = forcing.windU / windSpeed;
        const wV = forcing.windV / windSpeed;
        const down = downSlope * windSpeed + downOffset + downEps[i];
        const cross = crossSign[i] * (crossSlope * windSpeed + crossOffset + crossEps[i]);
        // Right-perpendicular of the downwind unit vector: (v, −u).
        vE += down * wU + cross * wV;
        vN += down * wV + cross * -wU;
      }

      lat[i] += (vN * dtS / EARTH_RADIUS_M) / DEG;
      const cosLat = Math.cos(lat[i] * DEG);
      lon[i] += (vE * dtS / (EARTH_RADIUS_M * (cosLat || 1e-9))) / DEG;

      if (jibeP > 0 && rng() < jibeP) crossSign[i] = -crossSign[i];
    }
    timesMs[step] = tMs;
    record(step);
  }

  return { timesMs, frames, n, degraded };
}
