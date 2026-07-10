import type { AreaFeature, Vec2 } from '../types'
import { COUNTRY_TO_REGION, REGION_PACKS } from './matrix'
import { climateTreePool } from './resolve'
import type {
  ClimateZone,
  LandCoverClass,
  RegionPack,
  ResolvedContext,
  TreeSpecies,
  WeightedVariant,
  ZoneKind,
} from './types'
import { MATRIX_VERSION } from './matrix'

// External context adapters. Each has a graceful fallback so a build never
// blocks on a third-party service; the source used is recorded in provenance.

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

// ---------- region (Nominatim reverse geocode) ----------

async function resolveRegion(lat: number, lng: number): Promise<{ pack: RegionPack; note: string }> {
  try {
    const res = await withTimeout(
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=5`),
      6000,
    )
    const d = await res.json()
    const cc: string = d?.address?.country_code ?? ''
    const regionId = COUNTRY_TO_REGION[cc]
    if (regionId) return { pack: REGION_PACKS[regionId], note: `region: ${regionId} (Nominatim country=${cc})` }
    return { pack: REGION_PACKS.generic, note: `region: generic (country=${cc || '?'} unmapped)` }
  } catch {
    return { pack: REGION_PACKS.generic, note: 'region: generic (Nominatim unreachable)' }
  }
}

// ---------- climate (Köppen-style heuristic, pluggable) ----------

const ARID_COUNTRIES = new Set(['ae', 'sa', 'eg', 'ly', 'dz', 'ma', 'jo', 'iq', 'ir', 'kw', 'qa', 'om'])
const MED_COUNTRIES = new Set(['es', 'pt', 'it', 'gr', 'hr', 'tr', 'cy', 'mt', 'il', 'lb', 'tn'])

function resolveClimate(lat: number, countryCode: string): { zone: ClimateZone; note: string } {
  const a = Math.abs(lat)
  let zone: ClimateZone
  if (ARID_COUNTRIES.has(countryCode)) zone = 'arid'
  else if (MED_COUNTRIES.has(countryCode)) zone = 'mediterranean'
  else if (a < 20) zone = 'tropical'
  else if (a < 35) zone = countryCode === 'au' ? 'mediterranean' : 'temperate'
  else if (a < 48) zone = 'temperate'
  else if (a < 60) zone = 'continental'
  else zone = 'boreal'
  return { zone, note: `climate: ${zone} (Köppen heuristic, lat=${lat.toFixed(1)}, cc=${countryCode || '?'})` }
}

// ---------- tree species (GBIF occurrences near the site) ----------

const GBIF_KEYWORDS: [RegExp, TreeSpecies][] = [
  [/pinus|picea|abies|larix|pseudotsuga|tsuga/i, 'conifer'],
  [/palm|phoenix|washingtonia|cocos|arecaceae|sabal/i, 'palm'],
  [/cupressus|populus nigra|juniperus|thuja/i, 'columnar'],
  [/acacia|prosopis|parkinsonia/i, 'acacia'],
  [/quercus|acer|platanus|tilia|ulmus|fraxinus|fagus|betula|ginkgo|celtis|prunus/i, 'broadleaf'],
]

async function resolveTreePool(
  bbox: { south: number; west: number; north: number; east: number },
  climate: ClimateZone,
): Promise<{ pool: WeightedVariant<TreeSpecies>[]; source: 'gbif' | 'climate-default'; note: string }> {
  const fallback = {
    pool: climateTreePool(climate),
    source: 'climate-default' as const,
    note: `tree pool: climate default (${climate})`,
  }
  try {
    const url =
      `https://api.gbif.org/v1/occurrence/search?limit=0&facet=speciesKey&facetLimit=10` +
      `&kingdomKey=6&basisOfRecord=HUMAN_OBSERVATION` +
      `&decimalLatitude=${bbox.south},${bbox.north}&decimalLongitude=${bbox.west},${bbox.east}`
    const res = await withTimeout(fetch(url), 7000)
    const d = await res.json()
    const counts: { name: string; count: number }[] = d?.facets?.[0]?.counts ?? []
    if (!counts.length) return fallback

    const speciesNames = await Promise.all(
      counts.slice(0, 8).map((c) =>
        withTimeout(fetch(`https://api.gbif.org/v1/species/${c.name}`), 5000)
          .then((r) => r.json())
          .then((s) => ({ name: `${s.scientificName ?? ''} ${s.family ?? ''}`, count: c.count }))
          .catch(() => null),
      ),
    )
    const weights = new Map<TreeSpecies, number>()
    for (const s of speciesNames) {
      if (!s) continue
      for (const [re, species] of GBIF_KEYWORDS) {
        if (re.test(s.name)) {
          weights.set(species, (weights.get(species) ?? 0) + s.count)
          break
        }
      }
    }
    if (weights.size === 0) return fallback
    // blend GBIF evidence with the climate prior so one dominant record can't zero out variety
    const pool: WeightedVariant<TreeSpecies>[] = climateTreePool(climate).map((v) => ({ ...v }))
    const maxW = Math.max(...weights.values())
    for (const [species, w] of weights) {
      const entry = pool.find((p) => p.value === species)
      const boost = 1 + (w / maxW) * 4
      if (entry) entry.weight += boost
      else pool.push({ value: species, weight: boost })
    }
    return { pool, source: 'gbif', note: `tree pool: GBIF-weighted (${[...weights.keys()].join(', ')})` }
  } catch {
    return fallback
  }
}

// ---------- land cover ----------
// Primary: ESA WorldCover WMS sample (best effort). Fallback: OSM-derived
// polygons (landuse/natural/leisure) which we already ingest.

interface PolyIndexEntry {
  ring: Vec2[]
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  cls: LandCoverClass | ZoneKind
}

function buildPolyIndex(areas: AreaFeature[], map: (a: AreaFeature) => LandCoverClass | ZoneKind | null): PolyIndexEntry[] {
  const out: PolyIndexEntry[] = []
  for (const a of areas) {
    const cls = map(a)
    if (!cls) continue
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const p of a.ring) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
    out.push({ ring: a.ring, minX, maxX, minZ, maxZ, cls })
  }
  return out
}

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

function sampler<T extends string>(index: PolyIndexEntry[], fallback: T): (p: Vec2) => T {
  return (p) => {
    for (const e of index) {
      if (p.x < e.minX || p.x > e.maxX || p.z < e.minZ || p.z > e.maxZ) continue
      if (pointInRing(p, e.ring)) return e.cls as T
    }
    return fallback
  }
}

const LANDCOVER_MAP: Partial<Record<AreaFeature['kind'], LandCoverClass>> = {
  water: 'water', forest: 'trees', park: 'grass', grass: 'grass',
}
const ZONE_MAP: Partial<Record<AreaFeature['kind'], ZoneKind>> = {
  residential: 'residential', commercial: 'commercial', retail: 'retail',
  industrial: 'industrial', park: 'park',
}

/** Best-effort ESA WorldCover probe — verifies reachability; classification still OSM until a raster pipeline lands (P1 bake service). */
async function probeWorldCover(): Promise<boolean> {
  try {
    const res = await withTimeout(
      fetch('https://services.terrascope.be/wms/v2?SERVICE=WMS&REQUEST=GetCapabilities', { method: 'HEAD', mode: 'no-cors' }),
      3000,
    )
    return !!res
  } catch {
    return false
  }
}

// ---------- CLIP (optional style classifier) ----------

export const CLIP_ADAPTER = {
  available: false,
  reason: 'Needs an inference endpoint (P2) — used to classify neighborhood style from street imagery.',
}

// ---------- orchestration ----------

export async function resolveContext(
  bbox: { south: number; west: number; north: number; east: number },
  areas: AreaFeature[],
  onStatus?: (m: string) => void,
): Promise<ResolvedContext> {
  const lat = (bbox.south + bbox.north) / 2
  const lng = (bbox.west + bbox.east) / 2
  const provenance: string[] = []

  onStatus?.('Resolving region & climate…')
  const region = await resolveRegion(lat, lng)
  provenance.push(region.note)

  // reuse Nominatim country for climate
  const ccMatch = region.note.match(/country=(\w\w)/)
  const climate = resolveClimate(lat, ccMatch?.[1] ?? '')
  provenance.push(climate.note)

  onStatus?.('Looking up regional tree species (GBIF)…')
  const trees = await resolveTreePool(bbox, climate.zone)
  provenance.push(trees.note)

  const worldCoverUp = await probeWorldCover()
  const landCoverSource = 'osm-derived' as const
  provenance.push(
    worldCoverUp
      ? 'land cover: OSM-derived polygons (WorldCover service reachable — raster sampling lands with the bake service)'
      : 'land cover: OSM-derived polygons (WorldCover unreachable)',
  )

  const lcIndex = buildPolyIndex(areas, (a) => LANDCOVER_MAP[a.kind] ?? null)
  const zoneIndex = buildPolyIndex(areas, (a) => ZONE_MAP[a.kind] ?? null)

  return {
    matrixVersion: MATRIX_VERSION,
    region: region.pack,
    climate: climate.zone,
    treePool: trees.pool,
    treePoolSource: trees.source,
    landCoverSource,
    landCoverAt: sampler<LandCoverClass>(lcIndex, 'built'),
    zoneAt: sampler<ZoneKind>(zoneIndex, 'none'),
    provenance,
  }
}
