import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from '../data/spriteOrder.js';
import { setOverlayEntries, clearOverlaySource } from '../overlays/worldOverlay.js';
import { metFromDirToUV, oceanToDirToUV } from './leeway.js';
import { createDriftPanel } from './driftPanel.js';

/**
 * Drift-simulation controller: fetches the marine forcing grid, runs the
 * leeway Monte Carlo in a worker, and renders the ensemble as a scrubbable
 * PointPrimitiveCollection under the shared sprite order ('ocean-drift'
 * slot, below vessels and aircraft). One simulation at a time; a new start
 * disposes the previous one.
 *
 * Everything on screen is labeled `SIMULATED DRIFT ENSEMBLE` — this is a
 * probabilistic visualization of forecast-driven leeway drift, not a SAR
 * product (Open-Meteo currents are coarse model forecasts: no nearshore
 * eddies, no tidal currents, no Stokes drift term in this MVP).
 */

export const DRIFT_OVERLAY_SOURCE_ID = 'ocean-drift';
const GRID_URL = '/api/ocean/marine-grid';

/**
 * Ensemble defaults, sized by the frame-buffer formula
 * n · (60·horizonH/dtMin + 1) frames · 2 floats · 4 bytes:
 * 10⁴ · 145 · 8 B ≈ 11.6 MB — comfortably transferable and scrubbable.
 * (5×10⁴ particles would need the horizon halved to stay in budget.)
 */
export const DRIFT_DEFAULTS = Object.freeze({
  n: 10000,
  horizonH: 24,
  dtMin: 10,
  posSigmaM: 150,
});

const PARTICLE_COLOR = Cesium.Color.fromCssColorString('#ffb14d');

/**
 * Normalize a `/api/ocean/marine-grid` payload into the leeway model's
 * forcing-grid contract (hour-major u/v component fields, m/s). Direction
 * conventions are resolved HERE, once: NDBC/Open-Meteo wind directions are
 * meteorological FROM, ocean current directions are oceanographic TO.
 * Missing samples become NaN — the model's sampler zero-fills them and
 * reports degradation; this function must never invent forcing.
 * @param {?Object} payload - Grid endpoint response body.
 * @returns {?Object} Normalized grid, or null when the payload is unusable.
 */
export function normalizeForcingGrid(payload) {
  const lats = payload?.grid?.lats;
  const lons = payload?.grid?.lons;
  const hoursMs = payload?.hoursMs;
  const nodes = payload?.nodes;
  if (!Array.isArray(lats) || !Array.isArray(lons) || !Array.isArray(hoursMs) || !Array.isArray(nodes)) return null;
  const nodeCount = lats.length * lons.length;
  if (!lats.length || !lons.length || !hoursMs.length || nodes.length !== nodeCount) return null;

  const size = hoursMs.length * nodeCount;
  const currentU = new Float32Array(size);
  const currentV = new Float32Array(size);
  const windU = new Float32Array(size);
  const windV = new Float32Array(size);

  for (let node = 0; node < nodeCount; node += 1) {
    const series = nodes[node] ?? {};
    for (let t = 0; t < hoursMs.length; t += 1) {
      const flat = t * nodeCount + node;
      const curKmh = series.currentKmh?.[t];
      const curDir = series.currentDirDeg?.[t];
      if (Number.isFinite(curKmh) && Number.isFinite(curDir)) {
        const { u, v } = oceanToDirToUV(curKmh / 3.6, curDir);
        currentU[flat] = u;
        currentV[flat] = v;
      } else {
        currentU[flat] = NaN;
        currentV[flat] = NaN;
      }
      const wind = series.windMs?.[t];
      const windDir = series.windDirDeg?.[t];
      if (Number.isFinite(wind) && Number.isFinite(windDir)) {
        const { u, v } = metFromDirToUV(wind, windDir);
        windU[flat] = u;
        windV[flat] = v;
      } else {
        windU[flat] = NaN;
        windV[flat] = NaN;
      }
    }
  }
  return { lats, lons, hoursMs, currentU, currentV, windU, windV };
}

/**
 * Nearest ensemble frame for a wall-clock time, clamped to the run's range.
 * @param {Float64Array|number[]} timesMs - Frame times.
 * @param {number} tMs - Query time.
 * @returns {number} Frame index, or -1 for an empty run.
 */
export function frameForTime(timesMs, tMs) {
  const length = timesMs?.length ?? 0;
  if (!length) return -1;
  if (tMs <= timesMs[0]) return 0;
  if (tMs >= timesMs[length - 1]) return length - 1;
  let best = 0;
  for (let i = 1; i < length; i += 1) {
    if (Math.abs(timesMs[i] - tMs) < Math.abs(timesMs[best] - tMs)) best = i;
  }
  return best;
}

/** Default worker-backed ensemble runner (kept injectable for tests). */
function runEnsembleInWorker(params) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./leeway.worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const message = event.data ?? {};
      worker.terminate();
      if (message.type === 'result') resolve(message);
      else reject(new Error(message.message || 'drift worker failed'));
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error instanceof Error ? error : new Error('drift worker error'));
    };
    worker.postMessage({ cmd: 'run', payload: params });
  });
}

/**
 * @param {Object} options
 * @param {Object} options.viewer Cesium viewer (scene.primitives is used).
 * @param {Object} [options.overlayHost] `{setEntries, clearSource}` (defaults to the world overlay).
 * @param {Function} [options.fetchImpl] Injectable fetch (tests).
 * @param {Function} [options.runEnsembleFn] Injectable ensemble runner (tests).
 * @param {Function} [options.collectionFactory] Injectable point-collection factory (tests).
 * @param {Function} [options.panelFactory] Injectable scrub-panel factory (tests).
 * @returns {{start: Function, setFrame: Function, play: Function, pause: Function, dispose: Function, isActive: Function}}
 */
export function createDriftController({
  viewer,
  overlayHost = { setEntries: setOverlayEntries, clearSource: clearOverlaySource },
  fetchImpl = (...args) => fetch(...args),
  runEnsembleFn = runEnsembleInWorker,
  collectionFactory = () => new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  panelFactory = createDriftPanel,
} = {}) {
  let _active = null; // {collection, points, timesMs, frames, n, frameIndex, panel, playTimer}

  function dispose() {
    if (!_active) return;
    if (_active.playTimer) clearInterval(_active.playTimer);
    _active.panel?.destroy?.();
    overlayHost.clearSource(DRIFT_OVERLAY_SOURCE_ID);
    viewer?.scene?.primitives?.remove?.(_active.collection);
    _active.collection?.destroy?.();
    _active = null;
    governorRequestRender('drift-dispose');
  }

  function setFrame(index) {
    if (!_active) return;
    const clamped = Math.max(0, Math.min(_active.timesMs.length - 1, Math.floor(index)));
    _active.frameIndex = clamped;
    const { frames, n, points } = _active;
    const offset = clamped * n * 2;
    for (let i = 0; i < n; i += 1) {
      points[i].position = Cesium.Cartesian3.fromDegrees(frames[offset + i * 2], frames[offset + i * 2 + 1]);
    }
    _active.panel?.setFrame?.(clamped, _active.timesMs[clamped] - _active.timesMs[0]);
    governorRequestRender('drift-scrub');
  }

  function pause() {
    if (!_active?.playTimer) return;
    clearInterval(_active.playTimer);
    _active.playTimer = null;
    _active.panel?.setPlaying?.(false);
  }

  function play() {
    if (!_active || _active.playTimer) return;
    _active.panel?.setPlaying?.(true);
    _active.playTimer = setInterval(() => {
      if (!_active) return;
      if (_active.frameIndex >= _active.timesMs.length - 1) {
        pause();
        return;
      }
      setFrame(_active.frameIndex + 1);
    }, 200);
  }

  /**
   * Start a drift simulation at an ocean point. Returns `{ok, reason?}` —
   * the caller owns telling the user when forcing is unavailable.
   */
  async function start({ lat, lon, label = '', n = DRIFT_DEFAULTS.n, horizonH = DRIFT_DEFAULTS.horizonH, dtMin = DRIFT_DEFAULTS.dtMin } = {}) {
    dispose();
    let grid = null;
    try {
      const params = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4) });
      const response = await fetchImpl(`${GRID_URL}?${params}`);
      if (response.ok) grid = normalizeForcingGrid(await response.json());
    } catch {
      grid = null;
    }
    if (!grid) return { ok: false, reason: 'marine forcing grid unavailable' };

    let result;
    try {
      result = await runEnsembleFn({
        n,
        seedLat: lat,
        seedLon: lon,
        startTimeMs: Date.now(),
        horizonH,
        dtMin,
        grid,
        rngSeed: Date.now() >>> 0,
        posSigmaM: DRIFT_DEFAULTS.posSigmaM,
      });
    } catch {
      return { ok: false, reason: 'drift ensemble failed' };
    }

    const collection = collectionFactory();
    const points = [];
    const startOffset = 0;
    for (let i = 0; i < result.n; i += 1) {
      points.push(collection.add({
        position: Cesium.Cartesian3.fromDegrees(
          result.frames[startOffset + i * 2],
          result.frames[startOffset + i * 2 + 1],
        ),
        pixelSize: 2.5,
        color: PARTICLE_COLOR.withAlpha(0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }));
    }
    viewer?.scene?.primitives?.add?.(collection);
    registerSpriteCollection('ocean-drift', collection);
    restoreSpriteOrder(viewer);

    const panel = panelFactory({
      particleCount: result.n,
      classLabel: 'PIW — person in water',
      frameCount: result.timesMs.length,
      horizonH,
      degraded: Boolean(result.degraded),
      label,
      onScrub: (index) => { pause(); setFrame(index); },
      onPlayPause: () => (_active?.playTimer ? pause() : play()),
      onClose: () => dispose(),
    });

    _active = {
      collection,
      points,
      timesMs: result.timesMs,
      frames: result.frames,
      n: result.n,
      frameIndex: 0,
      panel,
      playTimer: null,
    };

    overlayHost.setEntries(DRIFT_OVERLAY_SOURCE_ID, [{
      id: 'ocean-drift-banner',
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title: 'SIMULATED DRIFT ENSEMBLE',
      details: [`${result.n.toLocaleString()} particles · ${horizonH} h · PIW`,
        ...(result.degraded ? ['⚠ forcing gaps zero-filled'] : [])],
      accent: '#ffb14d',
      interactive: false,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    }], { cohortLimit: 1, collisionCapacity: 0, moving: false });

    setFrame(0);
    return { ok: true };
  }

  return {
    start,
    setFrame,
    play,
    pause,
    dispose,
    isActive: () => Boolean(_active),
  };
}
