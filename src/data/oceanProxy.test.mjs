import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOceanObs,
  buildMarineGridAxes,
  marineHoursToMs,
  normalizeMarineGridUpstream,
  fetchOceanObs,
} from '../../vite.config.js';

const OBS_TEXT =
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE\n' +
  '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft\n' +
  '46222    33.614 -118.314 2026 08 29 02 56  MM    MM    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n' +
  '14049   -12.000   65.000 2026 08 29 01 00 153   7.7   9.5   MM  MM   MM  MM 1016.2    MM  14.4  26.6    MM   MM     MM\n';

test('normalizeOceanObs joins station names from metadata and nulls the rest', () => {
  const records = [
    { stationId: '46222', lat: 33.614, lon: -118.314, waveHeightM: 0.8 },
    { stationId: '14049', lat: -12, lon: 65, waveHeightM: null },
  ];
  const meta = new Map([
    ['46222', { id: '46222', lat: 33.614, lon: -118.314, name: 'San Pedro, CA', type: 'buoy', met: false, currents: false }],
  ]);
  const stations = normalizeOceanObs(records, meta);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].name, 'San Pedro, CA');
  assert.equal(stations[0].type, 'buoy');
  assert.equal(stations[0].waveHeightM, 0.8);
  assert.equal(stations[1].name, null);
  assert.equal(stations[1].type, null);
});

test('buildMarineGridAxes yields 5x5 axes at 0.5 deg spacing centered on the seed', () => {
  const axes = buildMarineGridAxes(33.34, -118.33);
  assert.deepEqual(axes.lats, [32.34, 32.84, 33.34, 33.84, 34.34]);
  assert.deepEqual(axes.lons, [-119.33, -118.83, -118.33, -117.83, -117.33]);
});

test('buildMarineGridAxes clamps to valid latitude/longitude ranges near the edges', () => {
  const axes = buildMarineGridAxes(89.5, 179.8);
  assert.ok(axes.lats.every((lat) => lat >= -90 && lat <= 90));
  assert.ok(axes.lons.every((lon) => lon >= -180 && lon <= 180));
  assert.equal(axes.lats.length, 5);
  assert.equal(axes.lons.length, 5);
});

test('marineHoursToMs converts Open-Meteo ISO hours (UTC, no zone suffix) to epoch ms', () => {
  const hoursMs = marineHoursToMs(['2026-08-29T00:00', '2026-08-29T01:00']);
  assert.deepEqual(hoursMs, [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)]);
  assert.deepEqual(marineHoursToMs(['garbage']), null);
  assert.deepEqual(marineHoursToMs([]), null);
});

function marineElement(base) {
  return {
    hourly: {
      time: ['2026-08-29T00:00', '2026-08-29T01:00'],
      wave_height: [base, base + 0.1],
      ocean_current_velocity: [base * 2, base * 2 + 0.1],
      ocean_current_direction: [45, 90],
    },
  };
}

function windElement(base) {
  return {
    hourly: {
      time: ['2026-08-29T00:00', '2026-08-29T01:00'],
      wind_speed_10m: [base * 3, base * 3 + 0.1],
      wind_direction_10m: [180, 200],
    },
  };
}

test('normalizeMarineGridUpstream zips array-shaped marine + wind responses into nodes', () => {
  const marine = [marineElement(1), marineElement(2)];
  const wind = [windElement(1), windElement(2)];
  const grid = normalizeMarineGridUpstream(marine, wind, 2);
  assert.deepEqual(grid.hoursMs, [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)]);
  assert.equal(grid.nodes.length, 2);
  assert.deepEqual(grid.nodes[0].waveHeightM, [1, 1.1]);
  assert.deepEqual(grid.nodes[0].currentKmh, [2, 2.1]);
  assert.deepEqual(grid.nodes[0].currentDirDeg, [45, 90]);
  assert.deepEqual(grid.nodes[0].windMs, [3, 3.1]);
  assert.deepEqual(grid.nodes[1].windDirDeg, [180, 200]);
});

test('normalizeMarineGridUpstream accepts a single-object response when one node is expected', () => {
  const grid = normalizeMarineGridUpstream(marineElement(1), windElement(1), 1);
  assert.equal(grid.nodes.length, 1);
  assert.deepEqual(grid.nodes[0].waveHeightM, [1, 1.1]);
});

test('normalizeMarineGridUpstream returns null on node-count mismatch or missing hours', () => {
  assert.equal(normalizeMarineGridUpstream([marineElement(1)], [windElement(1)], 2), null);
  assert.equal(normalizeMarineGridUpstream({ hourly: { time: [] } }, windElement(1), 1), null);
});

test('fetchOceanObs parses upstream text through the NDBC gate with an injectable fetch', async () => {
  const payload = await fetchOceanObs({
    fetchImpl: async () => new Response(OBS_TEXT, { status: 200 }),
  });
  assert.equal(payload.stations.length, 2);
  assert.equal(payload.stations[0].stationId, '46222');
  assert.ok(Number.isFinite(payload.fetchedAtMs));
});

test('fetchOceanObs rejects HTML upstream bodies (broken feed, never cache them)', async () => {
  await assert.rejects(
    fetchOceanObs({ fetchImpl: async () => new Response('<html>503</html>', { status: 200 }) }),
    /non-NDBC/,
  );
});
