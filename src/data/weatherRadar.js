import * as Cesium from 'cesium';

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
// Tile-size segment, colour scheme, then smooth+snow flags. RainViewer serves
// 256 and 512; 256 keeps the request count down at the zoom levels a radar
// overlay is actually read at.
const TILE_SUFFIX = '/256/{z}/{x}/{y}/2/1_1.png';
const REFRESH_MS = 1_800_000; // 30 minutes, per the cadence agreed in issue #85

/**
 * Newest radar frame in a `weather-maps.json` payload, as a ready tile URL.
 *
 * The frame `path` is an OPAQUE HASH (e.g. `/v2/radar/3ae628836a15`), not a
 * timestamp-composed path. Rebuilding the path from `frame.time` 404s on every
 * tile, which is silent: Cesium renders an empty imagery layer rather than
 * raising, so the layer looks enabled and shows nothing. Compose from `host`
 * and `path` as returned and never from the timestamp.
 *
 * Pure and exported so the frame-selection contract is unit-testable without a
 * viewer or a network round trip.
 * @param {object} payload Parsed weather-maps.json.
 * @returns {{ url: string, time: number|null }}
 */
export function latestRadarTileUrl(payload) {
  const host = payload?.host;
  if (typeof host !== 'string' || host === '') {
    throw new Error('RainViewer response has no host');
  }
  // `nowcast` is forecast and is often empty; `past` is observed radar and is
  // the honest choice for a layer labelled LIVE. Prefer the newest observation.
  const frames = Array.isArray(payload?.radar?.past) ? payload.radar.past : [];
  const frame = frames[frames.length - 1];
  if (!frame || typeof frame.path !== 'string' || frame.path === '') {
    throw new Error('No radar frames available');
  }
  return {
    url: `${host}${frame.path}${TILE_SUFFIX}`,
    time: typeof frame.time === 'number' ? frame.time : null,
  };
}

export function createWeatherRadarLayer() {
  let _enabled = false;
  let _imageryLayer = null;
  let _lastUpdate = null;
  let _error = null;
  let _destroyed = false;
  let _refreshTimer = null;

  async function fetchLatestFrame() {
    const response = await fetch(RAINVIEWER_API);
    if (!response.ok) throw new Error(`RainViewer API returned ${response.status}`);
    return latestRadarTileUrl(await response.json());
  }

  async function loadTileLayer(viewer) {
    const { url, time } = await fetchLatestFrame();

    if (_imageryLayer) {
      viewer.imageryLayers.remove(_imageryLayer, true);
      _imageryLayer = null;
    }

    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 10,
      credit: 'RainViewer',
    });

    _imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    _imageryLayer.alpha = 0.45;
    _lastUpdate = time !== null ? time * 1000 : Date.now();
    _error = null;
  }

  function scheduleRefresh(viewer) {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      if (!_enabled || _destroyed) return;
      loadTileLayer(viewer).catch((e) => {
        _error = e.message;
        console.warn('[WeatherRadar] refresh failed:', e);
      });
    }, REFRESH_MS);
  }

  // Shared by `disable` and `destroy`. The PoC had `destroy` call `this.disable`
  // from an arrow function, which has no `this` binding to the returned object,
  // so every teardown threw a TypeError and leaked the imagery layer and timer.
  function teardown(viewer) {
    _enabled = false;
    if (_refreshTimer) {
      clearTimeout(_refreshTimer);
      _refreshTimer = null;
    }
    if (_imageryLayer && viewer && !viewer.isDestroyed()) {
      viewer.imageryLayers.remove(_imageryLayer, true);
    }
    _imageryLayer = null;
  }

  return {
    id: 'weather-radar',
    name: 'Weather Radar',
    icon: '☁', // (cloud)
    source: 'RainViewer · LIVE',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async (_viewer) => {},

    update: async (_viewer) => {},

    getStats: () => ({
      count: _imageryLayer ? 1 : 0,
      lastUpdate: _lastUpdate,
      error: _error,
    }),

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      try {
        await loadTileLayer(viewer);
        scheduleRefresh(viewer);
      } catch (e) {
        _error = e.message;
      }
    },

    disable: (viewer) => teardown(viewer),

    destroy: (viewer) => {
      _destroyed = true;
      teardown(viewer);
    },
  };
}
