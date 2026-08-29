import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import {
  cachedGroundFloor,
  floorAltitudeM,
  resolveGroundFloorCellsBounded,
} from './groundFloor.js';
// The shared batched/chunked/session-cached DEM warm chain. The module name is
// historical (it shipped with the FIRMS fire anchors); the mechanism itself is
// generic — cold coarse floor cells for a rendered point set, resolved strictly
// sequentially so overlapping renders cannot stack requests on the proxy.
import { warmFireAnchorFloors } from './fireAnchors.js';
import { normalizeMilitaryInstallations } from './militaryInstallationData.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

const LAYER_ID = 'military-installations';
const REQUEST_DEBOUNCE_MS = 500;
const MAX_VIEWPORT_DEGREES = 10;
const MAX_RENDERED = 700;
const GOOGLE_MILITARY_PLACE_TYPES = new Set(['military_base']);
const COLOR_BY_CLASS = {
  airfield: '#5aa9ff',
  naval_base: '#48c7d5',
  range: '#d9a85d',
  military_land: '#9ca6b0',
  places_candidate: '#c58cff',
};
const EARTH_MEAN_RADIUS_M = 6371008.8;
const DISTANCE_PREFILTER_MARGIN_M = 5000;
const distanceEndpointScratch = new Cesium.Cartographic();
const distanceGeodesicScratch = new Cesium.EllipsoidGeodesic();

/**
 * Allocation-free spherical distance used only as a conservative rejection
 * pass before the exact ellipsoidal geodesic calculation.
 */
export function approximateSurfaceDistanceM(latitudeARad, longitudeARad, latitudeBDeg, longitudeBDeg) {
  const latitudeBRad = Cesium.Math.toRadians(latitudeBDeg);
  const longitudeBRad = Cesium.Math.toRadians(longitudeBDeg);
  const latitudeDelta = latitudeBRad - latitudeARad;
  const longitudeDelta = Math.atan2(
    Math.sin(longitudeBRad - longitudeARad),
    Math.cos(longitudeBRad - longitudeARad),
  );
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine = sinLatitude * sinLatitude
    + Math.cos(latitudeARad) * Math.cos(latitudeBRad) * sinLongitude * sinLongitude;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  /** Record under the cursor, or null. Presentation only — never persisted. */
  hoveredId: null,
  /** Exact keydown callback registered on document, so destroy() can remove it. */
  keydownHandler: null,
  /**
   * Ordered installation ids for PREV/NEXT, or null when it needs rebuilding.
   *
   * Frozen on first use rather than recomputed per step, and deliberately not
   * "always jump to the nearest": nearest-from-here ping-pongs between two
   * mutual neighbours forever, and the counter would have no stable meaning.
   * A fixed order makes "3 / 59" true and the walk exhaustive.
   */
  navOrder: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  stale: false,
  /** Whether the upstream truncated at its element cap for the current view. */
  saturated: false,
  loading: false,
  abort: null,
  /** Pending timed retry while status is 'unavailable' (see scheduleUnavailableRetry). */
  retryTimer: null,
  /** Current backoff step for that retry; 0 = next failure starts at the minimum. */
  retryDelayMs: 0,
  moveEndRemove: null,
  clickHandler: null,
  timer: null,
  googleSearchRequested: false,
};

function colorFor(record) {
  return Cesium.Color.fromCssColorString(COLOR_BY_CLASS[record.class] || '#9ca6b0');
}

/**
 * Popup detail lines for a mapped installation.
 *
 * The label used to carry the class alone, which made every unnamed feature
 * read "MILITARY LAND" and nothing else — the provenance that decides whether
 * a viewer should trust the marker (which mapper, which OSM object, how old,
 * reviewed or not) was collected by registerEntityContext and then only ever
 * read back by the voice agent. These lines put it on screen.
 *
 * Pure and export-only so the wording is testable without a Cesium viewer.
 * @param {object} record Normalized installation record.
 * @returns {Array<string>} Rendered detail lines, in display order.
 */
export function installationDetailLines(record) {
  const lines = [String(record?.class || 'installation').replaceAll('_', ' ').toUpperCase()];

  // `osm:way:92701457` → `OSM WAY/92701457`: the reference a viewer can paste
  // into openstreetmap.org to see the mapper, the history and the full tags.
  const osmMatch = /^osm:(node|way|relation):(\d+)$/.exec(String(record?.id || ''));
  if (osmMatch) lines.push(`OSM ${osmMatch[1].toUpperCase()}/${osmMatch[2]}`);

  // Descriptive OSM tags, when the mappers supplied them. `wikipedia` arrives
  // as `de:Sportschule der Bundeswehr`; the language prefix is the lookup key,
  // so it stays. `wikidata` is only offered when no article exists — the two
  // together would spend three of five lines on the same fact.
  const tags = record?.osmTags || {};
  if (tags.short_name) lines.push(`AKA ${tags.short_name}`);
  if (tags.operator) lines.push(`OPERATOR · ${tags.operator.toUpperCase()}`);
  if (tags.start_date) lines.push(`SINCE ${tags.start_date}`);
  if (tags.wikipedia) lines.push(`WIKIPEDIA ${tags.wikipedia}`);
  else if (tags.wikidata) lines.push(`WIKIDATA ${tags.wikidata}`);

  const source = installationSourceLabel(record);
  if (source) lines.push(`SOURCE · ${source.toUpperCase()}`);

  // Google Places candidates are name matches, not mapped military land. Their
  // type is the only thing separating them from an OSM-tagged installation.
  const placeType = String(record?.primaryType || '').trim();
  if (placeType) lines.push(`PLACE TYPE · ${placeType.replaceAll('_', ' ').toUpperCase()}`);

  // Every record ships `validation: 'unreviewed'`. Saying so is the point: this
  // layer is community mapping, and the README calls it incomplete by nature.
  const validation = String(record?.validation || '').trim();
  if (validation) lines.push(validation.toUpperCase());

  const retrieved = Date.parse(record?.retrievedAt);
  if (Number.isFinite(retrieved)) {
    lines.push(`RETRIEVED ${new Date(retrieved).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  }
  return lines;
}

/**
 * Which emphasis a record carries this paint. Selection outranks hover so a
 * selected footprint does not dim when the cursor wanders onto a neighbour.
 * @param {string} id Record id.
 * @returns {'selected'|'hovered'|null}
 */
function emphasisFor(id) {
  if (id === state.selectedId) return 'selected';
  if (id === state.hoveredId) return 'hovered';
  return null;
}

/** Point size/colour for an emphasis level. */
function pointStyleFor(color, emphasis) {
  if (emphasis === 'selected') return { pixelSize: 13, color: Cesium.Color.WHITE };
  if (emphasis === 'hovered') return { pixelSize: 11, color: Cesium.Color.WHITE.withAlpha(0.85) };
  return { pixelSize: 9, color };
}

/**
 * Footprint fill/outline for an emphasis level.
 *
 * Selection previously changed the POINT only, so clicking a footprint left the
 * area itself at its resting 12 % fill and the only lasting feedback was a dot
 * two pixels wider — field report: "the area highlights once and then nothing".
 * Cesium ignores polygon outlineWidth on most platforms, so the emphasis has to
 * ride on alpha.
 */
function polygonStyleFor(color, emphasis) {
  if (emphasis === 'selected') return { material: color.withAlpha(0.34), outlineColor: Cesium.Color.WHITE.withAlpha(0.95) };
  if (emphasis === 'hovered') return { material: color.withAlpha(0.22), outlineColor: color.withAlpha(0.9) };
  return { material: color.withAlpha(0.12), outlineColor: color.withAlpha(0.65) };
}

/**
 * Repaint for the current selection/hover.
 *
 * Nothing is assigned here on purpose. The entities read their emphasis through
 * CallbackProperties (see renderRecords), so a hover change only needs a frame.
 *
 * Writing `entity.polygon.material` directly — the first attempt — made hover
 * flicker: assigning a material rebuilds the polygon's geometry, and during the
 * rebuild frame the primitive is gone, so the next MOUSE_MOVE pick returns null,
 * clears `hoveredId`, and schedules the opposite rebuild. The cursor sitting
 * still on one footprint oscillated. Callbacks keep the geometry static and move
 * only a per-instance colour attribute, which is also far cheaper.
 * @returns {void}
 */
function applyEmphasis() {
  governorRequestRender('installations-emphasis');
}

/**
 * Classify a Places text-search result without turning a name match into a
 * mapped military-land claim. Google currently has no documented military
 * Places type, so ordinary results remain visually distinct candidates; the
 * explicit branch is retained for any source response that does carry one.
 * @param {object} place Google Places result.
 * @returns {string|null} Installation class, or null when not authoritative.
 */
export function classifyGoogleMilitaryPlace(place) {
  const types = new Set([
    place?.primaryType,
    ...(Array.isArray(place?.types) ? place.types : []),
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  return [...types].some((type) => GOOGLE_MILITARY_PLACE_TYPES.has(type))
    ? 'military_land'
    : 'places_candidate';
}

/** @param {object} record @returns {string} Human-readable source attribution. */
export function installationSourceLabel(record) {
  const names = [...new Set((Array.isArray(record?.sources) ? record.sources : [])
    .map((source) => String(source?.name || '').trim())
    .filter(Boolean))];
  return names.join(' + ') || 'Unknown mapped source';
}

/**
 * Shared rendered-surface height for an installation anchor or footprint.
 * @param {{latitude:number, longitude:number}} record Installation record.
 * @returns {number} Ellipsoidal render height in metres.
 */
export function installationSurfaceHeightM(record) {
  return floorAltitudeM(
    null,
    cachedGroundFloor(record?.latitude, record?.longitude),
  ) ?? 0;
}

/**
 * Whether a mapped record belongs to the REQUESTED viewport.
 *
 * The proxy snaps the request bbox outward onto a shared cache grid, so a
 * response is a SUPERSET of what was asked for, and rendering that superset
 * would put off-screen sites into the map and into the "CURRENT VIEWPORT ONLY"
 * context claim. What may be tested depends on how much of a feature's geometry
 * we actually hold:
 *
 *  - A NODE is a point: its centre IS its whole geometry, so an exact
 *    containment test is correct and loses nothing.
 *  - A record WITH a footprint is tested by bounding-box overlap. Overpass bbox
 *    queries return features that merely INTERSECT the box, so centre-testing
 *    these would drop large bases whose centre sits just outside.
 *  - A way or relation WITHOUT a footprint is KEPT. Relations carry geometry on
 *    their members and ways beyond MAX_FOOTPRINT_POINTS are normalized without
 *    one, so their true extent is unknown here — and Overpass already proved
 *    they intersect the queried bbox. Centre-testing them would erase exactly
 *    the biggest installations. The honest cost is slight over-inclusion,
 *    bounded by one snap cell (~5.5 km) around the viewport.
 *
 * @param {{latitude:number, longitude:number, footprint:?Array, osmType:?string}} record
 * @param {{south:number, west:number, north:number, east:number}} box Requested viewport.
 * @returns {boolean}
 */
export function installationWithinViewport(record, box) {
  if (!record || !box) return false;
  const { latitude, longitude, footprint } = record;
  const centreInside = latitude >= box.south && latitude <= box.north
    && longitude >= box.west && longitude <= box.east;
  if (centreInside) return true;
  if (Array.isArray(footprint) && footprint.length) {
    let minLat = Infinity; let maxLat = -Infinity;
    let minLon = Infinity; let maxLon = -Infinity;
    for (const [lon, lat] of footprint) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return maxLat >= box.south && minLat <= box.north
      && maxLon >= box.west && minLon <= box.east;
  }
  // Unknown extent: inclusive. Only a point feature may be excluded on centre.
  return record.osmType !== 'node';
}

/**
 * Whether a response was truncated at the upstream element cap.
 *
 * The proxy states this outright, but a `saturated`-less payload is NOT
 * evidence of a complete answer: entries cached before the saturation guard
 * shipped predate the field and live for 30 days. Fall back to deriving it from
 * the element count against the cap the payload itself reports.
 * @param {{saturated?: boolean, elements?: Array, elementCap?: number}} payload
 * @returns {boolean}
 */
export function installationResponseSaturated(payload) {
  if (typeof payload?.saturated === 'boolean') return payload.saturated;
  const cap = Number(payload?.elementCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Array.isArray(payload?.elements) && payload.elements.length >= cap;
}

/**
 * Commit a status/error transition and buy the one frame it needs.
 *
 * With the render governor idle — Contacts has released its hold and nothing
 * else animates — no frame would otherwise arrive to re-read this, so a load
 * that fails after the scene went quiet would leave the last healthy readout on
 * screen indefinitely.
 * @param {string} status @param {?string} error
 */
function setInstallationStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('installations-status');
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  // Cross-dateline/global views require a zoom before a bounded request.
  if (!Number.isFinite(south + north + west + east) || east <= west || north - south > MAX_VIEWPORT_DEGREES || east - west > MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

/**
 * The records that get entities this paint: the nearest `MAX_RENDERED`, plus
 * the selected one when it falls outside that window.
 *
 * Context navigation walks the FULL nearby cohort, which is not bounded by the
 * render cap, so selecting item 701+ used to produce no entity at all — the
 * camera flew, `getById` returned null, and the selection was silently dropped
 * on the floor, leaving the Context subject stale so NEXT offered the same
 * installation forever. One extra entity keeps every cohort item selectable
 * and the cohort count honest.
 * @returns {Array<object>} Records to render this paint.
 */
function renderableRecords() {
  const rendered = state.records.slice(0, MAX_RENDERED);
  if (!state.selectedId) return rendered;
  if (rendered.some((record) => record.id === state.selectedId)) return rendered;
  const selected = state.recordById.get(state.selectedId);
  return selected ? [...rendered, selected] : rendered;
}

function renderRecords() {
  // Post-moveEnd debounced fetches commit after the camera settles; the
  // rebuilt entities need one frame in idle mode. (perf wave 2 fix)
  governorRequestRender('installations-render');
  clearRendered();
  for (const record of renderableRecords()) {
    const color = colorFor(record);
    const surfaceHeightM = installationSurfaceHeightM(record);
    const displayPosition = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      surfaceHeightM,
    );
    // Emphasis rides on CallbackProperties rather than on assignments made when
    // the hover changes: a material assignment rebuilds the polygon geometry,
    // and the resulting empty pick frame fed a flicker loop (see applyEmphasis).
    // `false` marks each property non-constant so Cesium re-reads it per frame
    // while keeping the geometry itself static.
    const recordId = record.id;
    const emphasis = () => emphasisFor(recordId);
    const entity = state.dataSource.entities.add({
      id: record.id,
      position: displayPosition,
      point: {
        pixelSize: new Cesium.CallbackProperty(() => pointStyleFor(color, emphasis()).pixelSize, false),
        color: new Cesium.CallbackProperty(() => pointStyleFor(color, emphasis()).color, false),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      polygon: record.footprint ? {
        hierarchy: new Cesium.PolygonHierarchy(record.footprint.map(([longitude, latitude]) => Cesium.Cartesian3.fromDegrees(longitude, latitude))),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => polygonStyleFor(color, emphasis()).material, false),
        ),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => polygonStyleFor(color, emphasis()).outlineColor, false),
        height: surfaceHeightM,
      } : undefined,
    });
    entity.gevTrackedId = `installations:${record.id}`;
    entity.gevDisplayPosition = () => displayPosition;
    entity.gevLabelModel = {
      title: record.name || 'MAPPED INSTALLATION',
      details: installationDetailLines(record),
      accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: record.kind === 'place_candidate'
        ? 'Military Site Search Candidates'
        : 'Mapped Military Installations',
      source: installationSourceLabel(record),
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        class: record.class,
        primaryType: record.primaryType || null,
        placeTypes: Array.isArray(record.placeTypes) ? record.placeTypes : [],
        validation: record.validation,
        retrievedAt: record.retrievedAt,
      },
    });
  }
  const selectedEntity = state.selectedId
    ? state.dataSource.entities.getById(state.selectedId)
    : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

/**
 * Second paint for floors that missed the bounded pre-render deadline.
 *
 * `resolveGroundFloorCellsBounded` gives up after FLOOR_RESOLVE_DEADLINE_MS so
 * a cold DEM can never hold the dots hostage — but the resolve keeps running
 * and lands seconds later, and without this the records it covers stay pinned
 * at ellipsoid height 0, sitting visibly under the 3D tiles (field test
 * 2026-08-18: "orange dots at the bottom").
 *
 * This is the render -> warm -> re-render chain FIRMS already uses, with one
 * difference the installations path forces: the trigger is whether a cell that
 * was COLD AT PAINT TIME is warm now, not whether this particular batch warmed
 * it. The bounded resolve above is still running against the same cells, so
 * asking "did MY batch warm anything" would answer false exactly when the other
 * resolve won the race — the common case. Still terminating: a set that is
 * wholly cold afterwards re-renders zero times and the next camera-driven load
 * retries.
 * @param {Array<object>} records Records just rendered.
 * @returns {void}
 */
function warmInstallationFloors(records) {
  const cold = records
    .filter((record) => cachedGroundFloor(record.latitude, record.longitude) == null)
    .map((record) => ({ lat: record.latitude, lon: record.longitude }));
  if (!cold.length) return;
  warmFireAnchorFloors(cold).then(() => {
    if (!state.enabled || !state.dataSource) return;
    if (!cold.some((point) => cachedGroundFloor(point.lat, point.lon) != null)) return;
    renderRecords();
  });
}

/**
 * Drop the current selection and its popup.
 *
 * Without this the label was a one-way door: `selectRecord` was the only writer
 * of `selectedId`, and it only ever ran on a hit, so a click on empty terrain
 * left the card standing over an installation the viewer had moved on from.
 * Mirrors the vessel layer's click-away / Escape pair.
 * @returns {boolean} Whether a selection was actually cleared.
 */
/**
 * The PREV/NEXT walk order, built once per roster.
 *
 * Sorted by distance from where the camera is looking when navigation first
 * starts, so NEXT from a standing start goes to the nearest installation rather
 * than to whatever Overpass happened to list first.
 * @returns {Array<string>} Installation ids, nearest first.
 */
function ensureNavOrder() {
  if (Array.isArray(state.navOrder)) return state.navOrder;
  const candidates = state.records.filter((record) => record.kind === 'installation');
  const camera = state.viewer?.camera;
  const origin = camera ? Cesium.Cartographic.fromCartesian(camera.positionWC) : null;
  if (origin) {
    candidates.sort((a, b) => approximateSurfaceDistanceM(origin.latitude, origin.longitude, a.latitude, a.longitude)
      - approximateSurfaceDistanceM(origin.latitude, origin.longitude, b.latitude, b.longitude));
  }
  state.navOrder = candidates.map((record) => record.id);
  return state.navOrder;
}

function deselectRecord() {
  if (!state.selectedId) return false;
  state.selectedId = null;
  clearSelectedEntityContextForLayer(LAYER_ID);
  renderRecords();
  return true;
}

function selectRecord(id) {
  const record = state.recordById.get(id);
  if (!record || !state.dataSource) return false;
  state.selectedId = id;
  renderRecords();
  // renderRecords drops selectedId when the record produced no entity.
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    // Empty terrain AND another layer's entity both end this selection: the
    // card belongs to whatever the viewer last pointed at, not to the last
    // installation they happened to hit.
    if (id && state.recordById.has(id)) selectRecord(id);
    else deselectRecord();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Hover emphasis. The pick runs on every mouse move, so the handler exits on
  // an unchanged id before touching a single entity — restyling costs nothing
  // while the cursor travels across an already-hovered footprint.
  state.clickHandler.setInputAction((movement) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(movement.endPosition);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    const next = id && state.recordById.has(id) ? id : null;
    if (next === state.hoveredId) return;
    state.hoveredId = next;
    applyEmphasis();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // Escape closes the card without moving the camera — the vessel layer's
  // keyboard escape hatch, for a selection made near the edge of the view where
  // there is no comfortable empty spot to click.
  state.keydownHandler = (event) => {
    if (!state.enabled || event.key !== 'Escape') return;
    deselectRecord();
  };
  document.addEventListener('keydown', state.keydownHandler);
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function installationRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/**
 * 'Temporarily unavailable' must mean temporarily: fetches otherwise fire only
 * on enable and on camera moveEnd, so a parked camera whose first request died
 * (one flaky Overpass mirror is enough) stayed unavailable forever while the
 * proxy sat healthy while the layer refused to show its features. While the
 * layer is enabled and
 * unavailable, retry on a 30 s → 240 s backoff; any success, user-driven load,
 * zoom-out, or disable cancels it.
 */
function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = installationRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadInstallations();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  // A user-driven load supersedes any pending retry; the load reschedules on
  // failure, so the backoff step is kept rather than reset.
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { loadInstallations(); }, REQUEST_DEBOUNCE_MS);
}

async function loadInstallations() {
  if (!state.enabled || !state.viewer) return;
  const box = viewportBox(state.viewer);
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    setInstallationStatus('zoom-in', 'Zoom in to load mapped installation context');
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.loading = true;
  try {
    const fetchInstallations = async (exact) => {
      const query = new URLSearchParams(Object.entries(box).map(([key, value]) => [key, value.toFixed(5)]));
      if (exact) query.set('exact', '1');
      const response = await fetch(`/api/military-installations?${query}`, { signal: requestAbort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Installation feed HTTP ${response.status}`);
      return body;
    };

    let payload = await fetchInstallations(false);
    // A SATURATED snapped tile was truncated upstream, so features from the
    // snap's extra ring may have crowded out sites actually on screen. Re-ask
    // for the exact viewport (separately keyed and cached) before rendering.
    let saturated = installationResponseSaturated(payload);
    if (saturated) {
      payload = await fetchInstallations(true);
      saturated = installationResponseSaturated(payload);
    }
    const normalized = normalizeMilitaryInstallations(payload, payload.retrievedAt || new Date().toISOString());
    // The proxy answers a bbox at least as large as the viewport; keep only what
    // was actually asked for so nothing off-screen reaches the map or the
    // "current viewport only" context claim.
    const records = normalized.records.filter((record) => installationWithinViewport(record, box));
    let placesError = null;
    if (state.googleSearchRequested) {
      state.googleSearchRequested = false;
      const latitude = (box.south + box.north) / 2;
      const longitude = (box.west + box.east) / 2;
      const radiusM = Math.min(50000, Math.max(1000, Math.round(Math.max(box.north - box.south, box.east - box.west) * 55_000)));
      try {
        const placesResponse = await fetch(`/api/google/text-search?${new URLSearchParams({
          q: 'military installation', lat: latitude.toFixed(5), lon: longitude.toFixed(5), radiusM: String(radiusM),
        })}`, { signal: requestAbort.signal });
        const placesPayload = await placesResponse.json();
        if (!placesResponse.ok) throw new Error(placesPayload?.error || `Google Places HTTP ${placesResponse.status}`);
        const seen = new Set(records.map((record) => `${record.name.toLowerCase()}|${record.latitude.toFixed(3)}|${record.longitude.toFixed(3)}`));
        for (const place of Array.isArray(placesPayload?.places) ? placesPayload.places : []) {
          if (!place?.id || !place?.name || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
          const placeClass = classifyGoogleMilitaryPlace(place);
          const signature = `${String(place.name).toLowerCase()}|${place.latitude.toFixed(3)}|${place.longitude.toFixed(3)}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          const retrievedAt = new Date().toISOString();
          records.push({
            id: `google:${place.id}`,
            kind: placeClass === 'military_land' ? 'installation' : 'place_candidate',
            class: placeClass,
            name: String(place.name).trim(),
            latitude: place.latitude,
            longitude: place.longitude,
            footprint: null,
            primaryType: place.primaryType || null,
            placeTypes: Array.isArray(place.types) ? place.types : [],
            sources: [{ name: 'Google Maps Places', id: place.id, retrievedAt }],
            validation: 'unreviewed',
            retrievedAt,
          });
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        placesError = 'Google Places search unavailable; showing mapped sites';
      }
    }
    await resolveGroundFloorCellsBounded(records.map((record) => ({
      lat: record.latitude,
      lon: record.longitude,
    })));
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    state.records = records;
    state.recordById = new Map(state.records.map((record) => [record.id, record]));
    // A new viewport is a new roster: the walk order and its "3 / 59" have to
    // be rebuilt, or NEXT would step through ids that are no longer rendered.
    state.navOrder = null;
    state.lastUpdate = Date.now();
    state.stale = payload.status === 'stale';
    // Even the exact-viewport retry can saturate in a dense area. Say so rather
    // than implying the view is completely surveyed.
    state.saturated = saturated;
    clearUnavailableRetry();
    setInstallationStatus(
      state.records.length ? (state.stale ? 'stale' : 'ready') : 'empty',
      payload.status === 'stale'
        ? 'Serving cached mapped context'
        : (saturated ? 'Too many mapped sites in view to list them all' : placesError),
    );
    renderRecords();
    warmInstallationFloors(state.records);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setInstallationStatus('unavailable', error?.message || 'Installation context unavailable');
    scheduleUnavailableRetry();
  } finally {
    // An older aborted request must not clear a newer request's busy state.
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const militaryInstallationsLayer = {
  id: LAYER_ID,
  name: 'Mapped Installations',
  icon: '⌖',
  source: 'OpenStreetMap + optional Google Maps Places',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('military-installations');
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
    state.dataSource.show = true;
    // DataLayerManager invokes update() immediately after enable(), which owns
    // the first fetch. Avoid racing it with a second aborting request here.
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearUnavailableRetry();
    clearTimeout(state.timer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
    // A stale hover would re-emphasize a record the next enable() renders.
    state.hoveredId = null;
  },
  update() { return loadInstallations(); },
  /** Request a one-shot Google Maps Places search around the current map view. */
  searchNearby() {
    state.googleSearchRequested = true;
    return loadInstallations();
  },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.clickHandler?.destroy();
    state.clickHandler = null;
    if (state.keydownHandler) document.removeEventListener('keydown', state.keydownHandler);
    state.keydownHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
  },
  getNearby(center, rangeM, maxCount = 50) {
    if (!center) return [];
    const range = Number.isFinite(rangeM) ? rangeM : Infinity;
    const centerCartographic = Cesium.Cartographic.fromCartesian(center);
    if (!centerCartographic) return [];
    const nearby = [];
    const approximateLimit = Number.isFinite(range)
      ? range * 1.03 + DISTANCE_PREFILTER_MARGIN_M
      : Infinity;
    for (const record of state.records) {
      if (record.kind !== 'installation') continue;
      if (approximateSurfaceDistanceM(
        centerCartographic.latitude,
        centerCartographic.longitude,
        record.latitude,
        record.longitude,
      ) > approximateLimit) continue;
      // The awareness disk is projected onto the ground. Confirm candidates
      // with an exact ellipsoidal surface distance and reusable scratch state.
      distanceEndpointScratch.longitude = Cesium.Math.toRadians(record.longitude);
      distanceEndpointScratch.latitude = Cesium.Math.toRadians(record.latitude);
      distanceEndpointScratch.height = 0;
      distanceGeodesicScratch.setEndPoints(centerCartographic, distanceEndpointScratch);
      const distanceM = distanceGeodesicScratch.surfaceDistance;
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      nearby.push({
        ...record,
        position: Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          installationSurfaceHeightM(record),
        ),
        distanceM,
      });
    }
    nearby.sort((a, b) => a.distanceM - b.distanceM);
    return nearby.slice(0, Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 50);
  },
  /**
   * Select and frame a mapped installation from another contextual UI.
   * @param {string} id Source-backed installation id.
   * @returns {boolean} True when an available installation was focused.
   */
  focusById(id) {
    const record = state.recordById.get(String(id));
    if (!record || !state.viewer) return false;
    // No camera flight without a real selection: a flight plus a stale subject
    // reads as success to Context navigation and strands NEXT on this item.
    if (!selectRecord(record.id)) return false;
    state.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          installationSurfaceHeightM(record),
        ),
        18000,
      ),
      { duration: 1.4 },
    );
    return true;
  },
  /**
   * Move the selection one step through the viewport roster and fly there.
   *
   * Until now the only way to reach a second installation was Global Context,
   * which needs a tracked aircraft or vessel as its subject — installations are
   * a cohort there, never the subject. So "show me these one after another"
   * had no answer at all for ground features.
   * @param {number} delta +1 for next, -1 for previous.
   * @returns {boolean} Whether a record was selected.
   */
  stepSelection(delta) {
    const order = ensureNavOrder();
    if (!order.length) return false;
    const step = Number(delta) < 0 ? -1 : 1;
    const current = state.selectedId ? order.indexOf(state.selectedId) : -1;
    // No selection yet: NEXT opens at the nearest, PREV at the farthest, so the
    // first keypress in either direction lands somewhere meaningful.
    const index = current === -1
      ? (step > 0 ? 0 : order.length - 1)
      : (current + step + order.length) % order.length;
    return this.focusById(order[index]);
  },
  /**
   * Roster position for the navigation panel.
   * @returns {{total:number, index:number, label:string|null}} `index` is
   *   1-based, or 0 when nothing is selected.
   */
  getNavigationState() {
    const order = ensureNavOrder();
    const index = state.selectedId ? order.indexOf(state.selectedId) : -1;
    return {
      total: order.length,
      index: index === -1 ? 0 : index + 1,
      label: index === -1 ? null : (state.recordById.get(order[index])?.name || null),
    };
  },
  getStats() {
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      stale: state.stale,
      saturated: state.saturated,
      error: state.error,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading mapped installation context' : '',
    };
  },
};

export default militaryInstallationsLayer;
