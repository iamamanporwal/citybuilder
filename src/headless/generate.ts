// Headless city generation: bbox (or pre-fetched OSM JSON) → export bundle,
// no browser required. This is the engine behind the CLI (tools/generate-city.ts)
// and the World API (api/v1/maps). Mirrors the browser orchestration in
// app/buildCity.ts minus UI concerns; the export artifacts are byte-compatible
// with the in-app export because both go through export/bundle.ts.

import './shims' // MUST be first — scene modules draw canvas textures at import time

import { ingestOverpass } from '../ingest/overpass'
import { resolveContext } from '../resolver/adapters'
import { prefetchRecognizerData } from '../recognizer/prepass'
import { loadLibraryTemplates } from '../scene/libraryTemplates'
import { scaleRoadNetwork, clampRoadScale } from '../procgen/roadScale'
import { setCrossSectionEnabled } from '../procgen/crossSection'
import { setFramedRoadsEnabled } from '../procgen/framedRoads'
import { useEditor } from '../state/store'
import { fetchOsmArea, type BBox, type FetchOptions } from '../ingest/overpassFetch'
import { buildExportBundle, type ExportBundle } from '../export/bundle'

export const MAX_AREA_KM2 = 12 // matches the in-app AreaPicker cap

export interface GenerateOptions {
  /** Area to fetch from Overpass. Omit when passing pre-fetched `raw`. */
  bbox?: BBox
  /** Pre-fetched raw Overpass JSON (samples, tests, cached fetches). */
  raw?: unknown
  /** Display name baked into semantics/attribution. */
  name?: string
  trees?: boolean
  signals?: boolean
  /** Road-width multiplier (1..4), the car-game "stretch roads" knob. */
  roadScale?: number
  /** Network elevation solve (semantics v3 y-channel). Default on. */
  corridorElevation?: boolean
  /** Terrain relief (procgen/terrain) drives world elevation. Default off (flat world). */
  terrain?: boolean
  /** Framed road cross-section (raised concrete curb-frame + footpath). Default on. */
  framedRoads?: boolean
  onProgress?: (message: string) => void
}

const KM_PER_DEG_LAT = 110.574

export function bboxAreaKm2(b: BBox): number {
  const midLat = (b.south + b.north) / 2
  const wKm = (b.east - b.west) * 111.32 * Math.cos((midLat * Math.PI) / 180)
  const hKm = (b.north - b.south) * KM_PER_DEG_LAT
  return wKm * hKm
}

export function validateBBox(b: BBox): string | null {
  if (![b.south, b.west, b.north, b.east].every(Number.isFinite)) return 'bbox values must be finite numbers'
  if (b.south >= b.north || b.west >= b.east) return 'bbox must have south < north and west < east'
  if (Math.abs(b.south) > 85 || Math.abs(b.north) > 85) return 'bbox latitude out of range'
  if (Math.abs(b.west) > 180 || Math.abs(b.east) > 180) return 'bbox longitude out of range'
  const area = bboxAreaKm2(b)
  if (area > MAX_AREA_KM2) return `area ${area.toFixed(1)} km² exceeds the ${MAX_AREA_KM2} km² cap`
  return null
}

/**
 * Generate a city and return the export bundle (GLBs + JSON as buffers).
 * Runs the same pipeline as the app: Overpass fetch → ingest → context
 * resolve + recognizer prepass → scene build → export gate + artifacts.
 */
export async function generateCity(opts: GenerateOptions): Promise<ExportBundle> {
  const progress = opts.onProgress ?? (() => {})
  const name = opts.name ?? 'Unnamed area'
  const s = useEditor.getState()

  let raw = opts.raw
  if (!raw) {
    if (!opts.bbox) throw new Error('generateCity: either bbox or raw OSM data is required')
    const bad = validateBBox(opts.bbox)
    if (bad) throw new Error(`generateCity: ${bad}`)
    progress('Querying OpenStreetMap…')
    const fetchOpts: FetchOptions = { trees: opts.trees ?? true, signals: opts.signals ?? true }
    raw = await fetchOsmArea(opts.bbox, fetchOpts, progress)
  }

  progress('Parsing map data…')
  const graph = ingestOverpass(raw as Parameters<typeof ingestOverpass>[0], name)
  if (graph.buildings.length === 0 && graph.roads.length === 0) {
    throw new Error('No streets or buildings found in this area — try a town or city center.')
  }

  progress('Resolving region context…')
  const [ctx] = await Promise.all([
    resolveContext(graph.bboxLatLng, graph.areas, progress),
    prefetchRecognizerData(graph.buildings),
  ])

  // Headless runs are procedural-only for now: the asset library serves GLBs
  // via the dev-server /assetlib route, which doesn't exist here.
  await loadLibraryTemplates([], false)
  s.setUseLibraryAssets(false)
  s.setUseCorridorElevation(opts.corridorElevation ?? true)
  s.setUseTerrain(opts.terrain ?? false)
  // Road crown / superelevation (#8/#22) off by default in API output — flat
  // carriageways. Set explicitly so a long-lived server process can't inherit a
  // stale module flag from a prior request.
  setCrossSectionEnabled(false)
  // Framed roads (raised curb-frame + footpath) default ON for API/headless
  // output; still set explicitly per request so a warm server instance can't
  // inherit a stale module flag.
  setFramedRoadsEnabled(opts.framedRoads ?? true)
  const roadScale = clampRoadScale(opts.roadScale ?? 1)
  s.setRoadScale(roadScale)

  progress('Generating roads, buildings & props…')
  useEditor.getState().initScene(scaleRoadNetwork(graph, roadScale), ctx)

  progress('Exporting GLBs + semantics…')
  return buildExportBundle()
}
