import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForcingGrid,
  frameForTime,
  createDriftController,
  DRIFT_OVERLAY_SOURCE_ID,
  DRIFT_DEFAULTS,
} from './driftController.js';

const HOURS = [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)];

/** Minimal 1x1 marine-grid payload (single node, two hours). */
function gridPayload() {
  return {
    status: 'ready',
    seed: { latitude: 33.5, longitude: -118.5 },
    grid: { lats: [33.5], lons: [-118.5] },
    hoursMs: HOURS,
    nodes: [{
      waveHeightM: [1, 1.1],
      currentKmh: [3.6, 7.2],
      currentDirDeg: [90, 90],
      windMs: [10, 10],
      windDirDeg: [180, 180],
    }],
  };
}

test('normalizeForcingGrid converts units and directions into u/v component fields', () => {
  const grid = normalizeForcingGrid(gridPayload());
  assert.deepEqual(grid.lats, [33.5]);
  assert.deepEqual(grid.lons, [-118.5]);
  assert.deepEqual(Array.from(grid.hoursMs), HOURS);
  // Current 3.6 km/h toward 90° → 1 m/s east at hour 0; 2 m/s at hour 1.
  assert.ok(Math.abs(grid.currentU[0] - 1) < 1e-9);
  assert.ok(Math.abs(grid.currentV[0]) < 1e-9);
  assert.ok(Math.abs(grid.currentU[1] - 2) < 1e-9);
  // Wind 10 m/s FROM 180° → blowing north: u≈0, v≈10.
  assert.ok(Math.abs(grid.windU[0]) < 1e-9);
  assert.ok(Math.abs(grid.windV[0] - 10) < 1e-9);
});

test('normalizeForcingGrid marks missing samples NaN and rejects malformed payloads', () => {
  const payload = gridPayload();
  payload.nodes[0].currentKmh[0] = null;
  const grid = normalizeForcingGrid(payload);
  assert.ok(Number.isNaN(grid.currentU[0]));
  assert.ok(Number.isFinite(grid.currentU[1]));

  assert.equal(normalizeForcingGrid(null), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: [], nodes: [] }), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: HOURS, nodes: [] }), null);
});

test('frameForTime clamps to the ensemble time range and picks the nearest frame', () => {
  const times = Float64Array.from([0, 600000, 1200000]);
  assert.equal(frameForTime(times, -5), 0);
  assert.equal(frameForTime(times, 250000), 0);
  assert.equal(frameForTime(times, 350000), 1);
  assert.equal(frameForTime(times, 9e12), 2);
  assert.equal(frameForTime(Float64Array.from([]), 0), -1);
});

function makeCollection() {
  const points = [];
  return {
    points,
    add(options) { const p = { ...options }; points.push(p); return p; },
    removeAll() { points.length = 0; },
    destroy() { this.destroyed = true; },
  };
}

function makeSeams() {
  const overlayCalls = [];
  const collection = makeCollection();
  const panel = { frames: [], destroyed: false };
  return {
    overlayCalls,
    collection,
    panel,
    options: {
      viewer: {
        scene: {
          primitives: {
            added: [],
            add(c) { this.added.push(c); return c; },
            remove(c) { this.added = this.added.filter((x) => x !== c); },
            raiseToTop() {},
          },
        },
      },
      overlayHost: {
        setEntries: (...args) => overlayCalls.push(['entries', ...args]),
        clearSource: (...args) => overlayCalls.push(['clear', ...args]),
      },
      fetchImpl: async () => ({ ok: true, json: async () => gridPayload() }),
      runEnsembleFn: async (params) => {
        // Two frames, params.n particles, all at the seed.
        const n = params.n;
        const frames = new Float32Array(2 * n * 2);
        for (let t = 0; t < 2; t += 1) {
          for (let i = 0; i < n; i += 1) {
            frames[(t * n + i) * 2] = params.seedLon + t * 0.01;
            frames[(t * n + i) * 2 + 1] = params.seedLat;
          }
        }
        return { timesMs: Float64Array.from(HOURS), frames, n, degraded: false };
      },
      collectionFactory: () => collection,
      panelFactory: () => ({
        setFrame: (i) => panel.frames.push(i),
        setPlaying: () => {},
        destroy: () => { panel.destroyed = true; },
      }),
    },
  };
}

test('start builds the particle cloud, publishes the SIMULATED banner, and setFrame scrubs it', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, label: 'test seed', n: 16 });
  assert.equal(result.ok, true);

  assert.equal(seams.collection.points.length, 16);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 1);

  const banner = seams.overlayCalls.find(([kind, sourceId]) => kind === 'entries' && sourceId === DRIFT_OVERLAY_SOURCE_ID);
  assert.ok(banner, 'drift banner published');
  assert.match(banner[2][0].title, /SIMULATED/i);

  const lonAtFrame0 = seams.collection.points[0].position;
  controller.setFrame(1);
  const lonAtFrame1 = seams.collection.points[0].position;
  assert.notDeepEqual(lonAtFrame1, lonAtFrame0, 'scrubbing moves the particles');

  controller.dispose();
  assert.equal(seams.collection.destroyed, true);
  assert.equal(seams.panel.destroyed, true);
  assert.ok(seams.overlayCalls.some(([kind, sourceId]) => kind === 'clear' && sourceId === DRIFT_OVERLAY_SOURCE_ID));
});

test('start reports failure when the forcing grid is unavailable', async () => {
  const seams = makeSeams();
  seams.options.fetchImpl = async () => ({ ok: false, status: 503 });
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 8 });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 0);
});

test('a second start disposes the first simulation', async () => {
  const seams = makeSeams();
  const first = makeCollection();
  const second = makeCollection();
  let call = 0;
  seams.options.collectionFactory = () => (call++ === 0 ? first : second);
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  await controller.start({ lat: 34.0, lon: -119.0, n: 4 });
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, undefined);
  controller.dispose();
});

test('defaults respect the frame-buffer memory budget', () => {
  // n · (60·horizonH/dtMin + 1) · 2 · 4 bytes — must stay ≈ tens of MB.
  const frames = DRIFT_DEFAULTS.n * (60 * DRIFT_DEFAULTS.horizonH / DRIFT_DEFAULTS.dtMin + 1) * 2 * 4;
  assert.ok(frames < 32 * 1024 * 1024, `frame buffer ${frames} bytes exceeds 32 MB`);
});
