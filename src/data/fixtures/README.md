# Test fixtures

- `ndbc-latest-obs-sample.txt` — a truncated capture of NOAA NDBC's bulk
  latest-observations feed, captured 2026-08-28 from
  `www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt`: both header lines, the
  first 80 station rows, plus every `46xxx` (Pacific) row so the sparse
  wave-only Catalina buoys (46221/46222/46253) and `MM` missing-value gaps are
  represented (184 data rows). Used ONLY by `src/data/ndbcText.test.mjs` to pin
  fixed-column parsing offline — it is a point-in-time snapshot, not a bundled
  data layer, and is never served to the app. NOAA/NDBC data, U.S. public
  domain.
- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.
