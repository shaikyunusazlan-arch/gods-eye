import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraOverpassUpstreams } from '../../vite.config.js';

// ---------------------------------------------------------------------------
// parseExtraOverpassUpstreams — operator-supplied mirrors
// ---------------------------------------------------------------------------

test('extra upstreams accept whitespace- and comma-separated URLs, in order', () => {
  assert.deepEqual(
    parseExtraOverpassUpstreams('https://a.example/api/interpreter, https://b.example/api/interpreter'),
    ['https://a.example/api/interpreter', 'https://b.example/api/interpreter'],
  );
  assert.deepEqual(
    parseExtraOverpassUpstreams('https://a.example/i\n https://b.example/i'),
    ['https://a.example/i', 'https://b.example/i'],
  );
  assert.deepEqual(parseExtraOverpassUpstreams(''), []);
  assert.deepEqual(parseExtraOverpassUpstreams(undefined), []);
});

test('a private or localhost mirror is allowed — unlike a webcam URL, this comes from the operator', () => {
  // The SSRF refusal in osmWebcamStillUrl guards a world-editable OSM tag. This
  // value is the operator's own env, where a self-hosted instance is the point.
  assert.deepEqual(parseExtraOverpassUpstreams('http://localhost:12345/api/interpreter'), ['http://localhost:12345/api/interpreter']);
  assert.deepEqual(parseExtraOverpassUpstreams('http://10.0.0.9/api/interpreter'), ['http://10.0.0.9/api/interpreter']);
});

test('unusable extra upstreams are dropped, not passed through to the fetch loop', () => {
  assert.deepEqual(parseExtraOverpassUpstreams('not-a-url ftp://x.example/i https://u:p@x.example/i'), []);
});

test('duplicate extra upstreams collapse so one mirror is not tried twice', () => {
  assert.deepEqual(
    parseExtraOverpassUpstreams('https://a.example/i https://a.example/i'),
    ['https://a.example/i'],
  );
});
