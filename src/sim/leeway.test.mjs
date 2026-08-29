import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEEWAY_CLASSES,
  EARTH_RADIUS_M,
  makeRng,
  randn,
  metFromDirToUV,
  oceanToDirToUV,
  perStepJibeProbability,
  makeForcingSampler,
  runEnsemble,
} from './leeway.js';

/** Uniform 2x2x2 forcing grid: constant current + wind everywhere. */
function constantGrid({ curU = 0, curV = 0, windU = 0, windV = 0 } = {}) {
  const nodes = 4;
  const hours = 2;
  const fill = (value) => Float32Array.from({ length: nodes * hours }, () => value);
  return {
    lats: [33, 34],
    lons: [-119, -118],
    hoursMs: [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 30, 0, 0)],
    currentU: fill(curU),
    currentV: fill(curV),
    windU: fill(windU),
    windV: fill(windV),
  };
}

const SEED_LAT = 33.5;
const SEED_LON = -118.5;
const M_PER_RAD = EARTH_RADIUS_M;

function meanDisplacementMeters(result, n) {
  const frames = result.frames;
  const T = result.timesMs.length;
  const last = (T - 1) * n * 2;
  let dLonDeg = 0;
  let dLatDeg = 0;
  for (let i = 0; i < n; i += 1) {
    dLonDeg += frames[last + i * 2] - SEED_LON;
    dLatDeg += frames[last + i * 2 + 1] - SEED_LAT;
  }
  dLonDeg /= n;
  dLatDeg /= n;
  const east = (dLonDeg * Math.PI / 180) * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  const north = (dLatDeg * Math.PI / 180) * M_PER_RAD;
  return { east, north };
}

test('PIW leeway coefficients are the published USCG taxonomy values', () => {
  const piw = LEEWAY_CLASSES.PIW;
  assert.equal(piw.downwind.slopePct, 0.96);
  assert.equal(piw.downwind.offsetCms, 0);
  assert.equal(piw.downwind.stdCms, 12.0);
  assert.equal(piw.crosswind.slopePct, 0.54);
  assert.equal(piw.crosswind.offsetCms, 0);
  assert.equal(piw.crosswind.stdCms, 9.4);
  assert.equal(piw.jibeRatePerHour, 0.04);
});

test('direction conventions: wind is FROM, current is TO', () => {
  const westWind = metFromDirToUV(10, 270); // FROM west → blowing east
  assert.ok(Math.abs(westWind.u - 10) < 1e-9);
  assert.ok(Math.abs(westWind.v) < 1e-9);
  const northWind = metFromDirToUV(5, 0); // FROM north → blowing south
  assert.ok(Math.abs(northWind.u) < 1e-9);
  assert.ok(Math.abs(northWind.v + 5) < 1e-9);
  const eastCurrent = oceanToDirToUV(1, 90); // TO east
  assert.ok(Math.abs(eastCurrent.u - 1) < 1e-9);
  assert.ok(Math.abs(eastCurrent.v) < 1e-9);
});

test('per-step jibe probability matches the exponential-rate closed form', () => {
  // λ = -ln(1 - 0.04)/3600 s⁻¹; p(600 s) = 1 - exp(-λ·600)
  const expected = 1 - Math.exp(Math.log(1 - 0.04) * 600 / 3600);
  assert.ok(Math.abs(perStepJibeProbability(0.04, 600) - expected) < 1e-12);
  assert.equal(perStepJibeProbability(0, 600), 0);
});

test('rng is deterministic and randn produces both signs', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 5; i += 1) assert.equal(a(), b());
  const rng = makeRng(7);
  const draws = Array.from({ length: 100 }, () => randn(rng));
  assert.ok(draws.some((x) => x > 0) && draws.some((x) => x < 0));
});

test('forcing sampler reproduces a bilinear field and interpolates time linearly', () => {
  const grid = constantGrid();
  // Make currentU vary linearly with lon index at hour 0: nodes are lat-major.
  grid.currentU = Float32Array.from([0, 1, 0, 1, /* hour 1: */ 2, 3, 2, 3]);
  const sampler = makeForcingSampler(grid);
  const midLon = sampler(33, -118.5, grid.hoursMs[0]);
  assert.ok(Math.abs(midLon.curU - 0.5) < 1e-6, 'spatial midpoint of 0..1');
  const midTime = sampler(33, -119, (grid.hoursMs[0] + grid.hoursMs[1]) / 2);
  assert.ok(Math.abs(midTime.curU - 1) < 1e-6, 'time midpoint of 0..2');
  assert.equal(midTime.degraded, false);
});

test('forcing sampler zero-fills NaN nodes and flags degradation', () => {
  const grid = constantGrid({ curU: 0.5 });
  grid.currentU[0] = NaN;
  const sampler = makeForcingSampler(grid);
  const sample = sampler(33, -119, grid.hoursMs[0]);
  assert.ok(Number.isFinite(sample.curU));
  assert.equal(sample.degraded, true);
});

test('same seed → identical ensemble; different seed → different ensemble', () => {
  const options = {
    n: 64, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 2, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 8 }), rngSeed: 1234,
  };
  const a = runEnsemble(options);
  const b = runEnsemble(options);
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  const c = runEnsemble({ ...options, rngSeed: 999 });
  assert.notDeepEqual(Array.from(a.frames), Array.from(c.frames));
});

test('constant current + wind: ensemble mean drift matches the hand-computed leeway expectation', () => {
  const n = 2000;
  const horizonH = 6;
  // Current 0.3 m/s east; wind 10 m/s blowing north (FROM south).
  const result = runEnsemble({
    n, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 10 }), rngSeed: 42,
  });
  const T = horizonH * 3600;
  const { east, north } = meanDisplacementMeters(result, n);
  // East: current only (crosswind signs are balanced) → 0.3 · 21600 = 6480 m.
  assert.ok(Math.abs(east - 0.3 * T) < 300, `east ${east.toFixed(0)} m vs ${0.3 * T} m`);
  // North: downwind leeway 0.96 % of 10 m/s = 0.096 m/s → 2073.6 m.
  assert.ok(Math.abs(north - 0.096 * T) < 300, `north ${north.toFixed(0)} m vs ${(0.096 * T).toFixed(0)} m`);
});

test('crosswind spreads symmetrically and jibing tightens the crosswind spread', () => {
  const base = {
    n: 1000, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid: constantGrid({ windV: 10 }), rngSeed: 5,
  };
  const noJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 0 } });
  const fastJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 20 } });

  const spreadEast = (result) => {
    const frames = result.frames;
    const last = (result.timesMs.length - 1) * base.n * 2;
    const lons = [];
    for (let i = 0; i < base.n; i += 1) lons.push(frames[last + i * 2]);
    const mean = lons.reduce((s, x) => s + x, 0) / lons.length;
    const variance = lons.reduce((s, x) => s + (x - mean) ** 2, 0) / lons.length;
    return { mean, sd: Math.sqrt(variance) };
  };

  const still = spreadEast(noJibe);
  // Balanced ± crosswind signs: the mean east displacement stays near zero
  // relative to the per-particle crosswind excursion (~1.2 km at 6 h).
  const meanEastM = (still.mean - SEED_LON) * Math.PI / 180 * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  assert.ok(Math.abs(meanEastM) < 200, `mean east ${meanEastM.toFixed(0)} m`);
  // Rapid jibing decorrelates the crosswind sign → tighter spread.
  assert.ok(spreadEast(fastJibe).sd < still.sd * 0.7, 'jibing must shrink crosswind dispersion');
});

test('every frame stays finite even when forcing has NaN holes', () => {
  const grid = constantGrid({ curU: 0.4, windV: 6 });
  grid.currentU[1] = NaN;
  grid.windV[2] = NaN;
  const result = runEnsemble({
    n: 128, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 3, dtMin: 10,
    grid, rngSeed: 11,
  });
  assert.equal(result.frames.length, result.timesMs.length * 128 * 2);
  for (const value of result.frames) assert.ok(Number.isFinite(value));
});
