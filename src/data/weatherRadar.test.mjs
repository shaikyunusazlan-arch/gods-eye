import test from 'node:test';
import assert from 'node:assert/strict';

import { latestRadarTileUrl } from './weatherRadar.js';

const HOST = 'https://tilecache.rainviewer.com';

function payload(past) {
  return { host: HOST, radar: { past, nowcast: [] } };
}

test('the newest past frame becomes a tile URL built from its opaque path', () => {
  const { url, time } = latestRadarTileUrl(payload([
    { time: 1787971200, path: '/v2/radar/aaaaaaaaaaaa' },
    { time: 1787971800, path: '/v2/radar/3ae628836a15' },
  ]));
  // The LAST frame wins, and the path is used verbatim.
  assert.equal(url, `${HOST}/v2/radar/3ae628836a15/256/{z}/{x}/{y}/2/1_1.png`);
  assert.equal(time, 1787971800);
});

test('the frame timestamp is never used to compose the path', () => {
  // This is the PoC bug the layer shipped with: rebuilding the path from
  // `time` yields a URL that 404s on every tile while Cesium renders an empty
  // layer instead of raising, so the failure is silent.
  const { url } = latestRadarTileUrl(payload([{ time: 1787971800, path: '/v2/radar/3ae628836a15' }]));
  assert.ok(!url.includes('1787971800'), 'timestamp must not appear in the tile URL');
});

test('an empty or missing frame list fails loudly rather than returning a dead URL', () => {
  assert.throws(() => latestRadarTileUrl(payload([])), /No radar frames available/);
  assert.throws(() => latestRadarTileUrl({ host: HOST, radar: {} }), /No radar frames available/);
  assert.throws(() => latestRadarTileUrl({ host: HOST }), /No radar frames available/);
});

test('a frame without a usable path is rejected, not silently formatted', () => {
  assert.throws(() => latestRadarTileUrl(payload([{ time: 1, path: '' }])), /No radar frames available/);
  assert.throws(() => latestRadarTileUrl(payload([{ time: 1 }])), /No radar frames available/);
});

test('a response without a host is rejected before any URL is built', () => {
  assert.throws(
    () => latestRadarTileUrl({ radar: { past: [{ time: 1, path: '/v2/radar/x' }] } }),
    /no host/,
  );
  assert.throws(() => latestRadarTileUrl({}), /no host/);
  assert.throws(() => latestRadarTileUrl(null), /no host/);
});

test('a frame with a non-numeric time still yields a URL, with a null time', () => {
  const { url, time } = latestRadarTileUrl(payload([{ path: '/v2/radar/3ae628836a15' }]));
  assert.equal(url, `${HOST}/v2/radar/3ae628836a15/256/{z}/{x}/{y}/2/1_1.png`);
  assert.equal(time, null);
});
