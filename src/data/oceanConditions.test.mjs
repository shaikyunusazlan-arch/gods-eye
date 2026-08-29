import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';

import {
  createOceanConditionsLayer,
  createOceanOverlayEntry,
  selectOceanOverlayCohort,
  createOceanSelectedOverlayEntry,
  buoyColorForWaveHeight,
  formatBuoyCardLines,
  formatMarineForecastLines,
  nearestForecastHourIndex,
  kmhToMs,
  mapAnalystRecord,
  OCEAN_OVERLAY_SOURCE_ID,
  OCEAN_SELECTED_OVERLAY_SOURCE_ID,
  OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS,
  OCEAN_OVERLAY_COHORT_LIMIT,
} from './oceanConditions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATION_46222 = {
  stationId: '46222', lat: 33.614, lon: -118.314, timeMs: Date.UTC(2026, 7, 29, 2, 56),
  windDirDeg: null, windSpeedMs: null, gustMs: null,
  waveHeightM: 0.8, dominantPeriodS: 8, avgPeriodS: 5.5, waveDirDeg: 215,
  pressureHpa: null, pressureTendencyHpa: null, airTempC: null, sstC: 24.5,
  dewPointC: null, visibilityNmi: null, tideFt: null,
  name: 'San Pedro, CA', type: 'buoy',
};

const STATION_14049 = {
  stationId: '14049', lat: -12, lon: 65, timeMs: Date.UTC(2026, 7, 29, 1, 0),
  windDirDeg: 153, windSpeedMs: 7.7, gustMs: 9.5,
  waveHeightM: null, dominantPeriodS: null, avgPeriodS: null, waveDirDeg: null,
  pressureHpa: 1016.2, pressureTendencyHpa: null, airTempC: 14.4, sstC: 26.6,
  dewPointC: null, visibilityNmi: null, tideFt: null,
  name: null, type: null,
};

const MARINE_PAYLOAD = {
  status: 'ready',
  coordinates: { latitude: 33.61, longitude: -118.31 },
  marine: {
    time: ['2026-08-29T00:00', '2026-08-29T01:00'],
    wave_height: [1.1, 1.2],
    wave_period: [12, 13],
    sea_surface_temperature: [21.2, 21.3],
    ocean_current_velocity: [0.36, 0.72],
    ocean_current_direction: [40, 45],
  },
  wind: {
    time: ['2026-08-29T00:00', '2026-08-29T01:00'],
    wind_speed_10m: [4.1, 4.2],
    wind_direction_10m: [200, 210],
  },
};

function makeOverlayHostSpy() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
}

function makeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      list: dataSources,
      add(ds) { dataSources.push(ds); return ds; },
      remove(ds) {
        const i = dataSources.indexOf(ds);
        if (i !== -1) dataSources.splice(i, 1);
        return true;
      },
    },
    entities: new Cesium.EntityCollection(),
    scene: {},
  };
}

function obsResponse(stations) {
  return {
    ok: true,
    json: async () => ({ status: 'ready', fetchedAtMs: Date.now(), count: stations.length, stations }),
  };
}

test('buoyColorForWaveHeight bands wave height and dims missing data', () => {
  const noData = buoyColorForWaveHeight(null);
  const calm = buoyColorForWaveHeight(0.5);
  const moderate = buoyColorForWaveHeight(1.8);
  const rough = buoyColorForWaveHeight(3.1);
  const high = buoyColorForWaveHeight(4.9);
  const extreme = buoyColorForWaveHeight(7.5);
  const all = [noData, calm, moderate, rough, high, extreme].map((c) => c.toCssColorString());
  assert.equal(new Set(all).size, 6, 'each band gets a distinct color');
  assert.ok(all.every((css) => typeof css === 'string' && css.length > 0));
});

test('formatBuoyCardLines renders only present fields and never the text null', () => {
  const waveLines = formatBuoyCardLines(STATION_46222);
  assert.equal(waveLines[0], 'San Pedro, CA');
  assert.ok(waveLines.some((line) => line.includes('0.8 m')));
  assert.ok(waveLines.some((line) => line.includes('24.5')));
  assert.ok(!waveLines.some((line) => line.includes('null')));
  assert.ok(!waveLines.some((line) => /wind/i.test(line)), 'no wind line when wind is absent');

  const windLines = formatBuoyCardLines(STATION_14049);
  assert.equal(windLines[0], 'Buoy 14049');
  assert.ok(windLines.some((line) => line.includes('7.7 m/s')));
  assert.ok(!windLines.some((line) => /wave|🌊/i.test(line)), 'no wave line when waves are absent');
});

test('kmhToMs converts and passes null through', () => {
  assert.equal(kmhToMs(3.6), 1);
  assert.equal(kmhToMs(null), null);
  assert.equal(kmhToMs(undefined), null);
});

test('nearestForecastHourIndex picks the closest hour and -1 for empty input', () => {
  const hours = [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)];
  assert.equal(nearestForecastHourIndex(hours, Date.UTC(2026, 7, 29, 0, 20)), 0);
  assert.equal(nearestForecastHourIndex(hours, Date.UTC(2026, 7, 29, 0, 40)), 1);
  assert.equal(nearestForecastHourIndex([], Date.now()), -1);
});

test('formatMarineForecastLines reads the nearest forecast hour and converts current to m/s', () => {
  const lines = formatMarineForecastLines(MARINE_PAYLOAD, Date.UTC(2026, 7, 29, 1, 5));
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((line) => line.includes('1.2 m')), 'wave height from hour index 1');
  assert.ok(lines.some((line) => line.includes('0.2 m/s')), 'current 0.72 km/h -> 0.2 m/s');
  assert.ok(lines.some((line) => line.includes('4.2 m/s')), 'wind from hour index 1');
  assert.ok(!lines.some((line) => line.includes('null')));
});

test('formatMarineForecastLines returns [] when the forecast carries no usable values', () => {
  const empty = {
    marine: { time: ['2026-08-29T00:00'], wave_height: [null], sea_surface_temperature: [null], ocean_current_velocity: [null], ocean_current_direction: [null] },
    wind: null,
  };
  assert.deepEqual(formatMarineForecastLines(empty, Date.UTC(2026, 7, 29, 0, 0)), []);
  assert.deepEqual(formatMarineForecastLines(null, Date.now()), []);
});

test('mapAnalystRecord is JSON-safe with an index fallback id', () => {
  const record = mapAnalystRecord(STATION_46222, 0);
  assert.equal(record.id, '46222');
  assert.equal(record.stationId, '46222');
  assert.equal(record.name, 'San Pedro, CA');
  assert.equal(record.waveHeightM, 0.8);
  assert.equal(record.windSpeedMs, null);
  for (const value of Object.values(record)) assert.ok(!Number.isNaN(value));
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);

  const fallback = mapAnalystRecord({}, 7);
  assert.equal(fallback.id, 'BUOY-0007');
});

test('overlay cohort keeps the biggest waves with stable tie-break and hard cap', () => {
  const entries = [];
  for (let i = 0; i < OCEAN_OVERLAY_COHORT_LIMIT + 5; i += 1) {
    entries.push(createOceanOverlayEntry({
      id: `s${String(i).padStart(2, '0')}`,
      position: { x: i, y: 0, z: 0 },
      waveHeightM: (i % 7) + 0.1,
      accent: '#00ffff',
    }));
  }
  const cohort = selectOceanOverlayCohort(entries);
  assert.equal(cohort.length, OCEAN_OVERLAY_COHORT_LIMIT);
  for (let i = 1; i < cohort.length; i += 1) {
    assert.ok(cohort[i - 1].priority >= cohort[i].priority);
  }
  const entry = cohort[0];
  assert.equal(entry.variant, 'label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.interactive, false);
});

test('selected overlay entry is protected, selected-lane, and title/details split', () => {
  const entry = createOceanSelectedOverlayEntry('ndbc:46222', {
    position: { x: 1, y: 2, z: 3 },
    lines: ['San Pedro, CA', '🌊 0.8 m @ 8 s → 215°'],
  });
  assert.equal(entry.id, 'ndbc:46222');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.title, 'San Pedro, CA');
  assert.deepEqual(entry.details, ['🌊 0.8 m @ 8 s → 215°']);
  assert.equal(createOceanSelectedOverlayEntry('', { position: null, lines: [] }), null);
});

test('lifecycle: init/enable/update publishes entities and a guarded overlay cohort', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => obsResponse([STATION_46222, STATION_14049]);
  try {
    layer.init(viewer);
    assert.equal(viewer.dataSources.list.length, 1);

    // Update while disabled: entities load, overlay stays unpublished.
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer.dataSources.list[0].entities.values.length, 2);
    assert.ok(!overlayHost.calls.some(([kind]) => kind === 'entries'));

    layer.enable(viewer);
    assert.equal(await layer.update(viewer), true);
    const publication = overlayHost.calls.find(([kind]) => kind === 'entries');
    assert.ok(publication, 'enabled update publishes the overlay cohort');
    assert.equal(publication[1], OCEAN_OVERLAY_SOURCE_ID);
    assert.equal(publication[2].length, 1, 'only wave-reporting stations get ambient labels');
    assert.equal(publication[3].moving, false);

    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.error, null);

    layer.disable(viewer);
    const tail = overlayHost.calls.slice(-2);
    assert.equal(tail[0][0], 'clear');
    assert.equal(tail[1][0], 'visible');
    assert.equal(tail[1][2], false);

    layer.destroy(viewer);
    assert.equal(viewer.dataSources.list.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('update failure records an error string and a later success clears it', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  try {
    layer.init(viewer);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.match(layer.getStats().error, /503/);

    globalThis.fetch = async () => obsResponse([STATION_46222]);
    assert.equal(await layer.update(viewer), true);
    assert.equal(layer.getStats().error, null);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('selection publishes a protected card, then appends marine forecast lines', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/ocean/marine')) {
      return { ok: true, json: async () => MARINE_PAYLOAD };
    }
    return obsResponse([STATION_46222]);
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    await layer._selectForTest('ndbc:46222');
    const selectedCalls = overlayHost.calls.filter(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    );
    assert.ok(selectedCalls.length >= 2, 'immediate card, then forecast-augmented card');
    assert.deepEqual(selectedCalls[0][3], OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS);
    const finalDetails = selectedCalls.at(-1)[2][0].details;
    assert.ok(finalDetails.some((line) => line.includes('m/s')), 'forecast lines appended');

    layer._clearSelectionForTest();
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'clear' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    ));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('analyst records come from live entities and are JSON-safe', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => obsResponse([STATION_46222, STATION_14049]);
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 2);
    const rec = records.find((r) => r.stationId === '46222');
    assert.equal(rec.waveHeightM, 0.8);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
    layer.disable(viewer);
    assert.deepEqual(layer.getAnalystRecords(), []);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('source pins: no CallbackProperty, no continuous-render hold', () => {
  const source = fs.readFileSync(path.join(__dirname, 'oceanConditions.js'), 'utf8');
  assert.doesNotMatch(source, /new Cesium\.CallbackProperty/);
  assert.doesNotMatch(source, /holdContinuousRender/);
});
