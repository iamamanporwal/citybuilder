import type {
  AreaFeature,
  AreaKind,
  BarrierFeature,
  BuildingFeature,
  CityGraph,
  PointFeature,
  RoadClass,
  RoadSegment,
  Vec2,
} from '../types'
import { clipRingToRect, offsetPolyline, pointInRing, ringAreaM2, ringIsSimple, type Rect } from '../procgen/geometry'
import polygonClipping from 'polygon-clipping'

type ClipRing = [number, number][]

// Overpass/OSM adapter: maps raw OSM JSON into the internal City Graph schema.
// Other adapters (Overture, premium HD-map) implement the same output contract.

interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

const ROAD_CLASSES: RoadClass[] = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'service',
  'footway',
  'cycleway',
]

// default full carriageway width (m) per class when data lacks width/lanes
const CLASS_WIDTH: Record<RoadClass, number> = {
  motorway: 14,
  trunk: 12,
  primary: 11,
  secondary: 9,
  tertiary: 8,
  residential: 7,
  unclassified: 7,
  living_street: 5.5,
  pedestrian: 5,
  service: 4,
  footway: 2,
  cycleway: 2.5,
}

const CLASS_LANES: Record<RoadClass, number> = {
  motorway: 4,
  trunk: 3,
  primary: 3,
  secondary: 2,
  tertiary: 2,
  residential: 2,
  unclassified: 2,
  living_street: 1,
  pedestrian: 0,
  service: 1,
  footway: 0,
  cycleway: 0,
}

// ---- water whitelist (see docs/water-and-flicker-rca.md) ----
// Only real standing/flowing water bodies are ever painted blue. Everything
// else — wetlands, fountains, pools, basins, covered/culverted channels —
// stays land. Land is the default base; water requires positive evidence.

/** natural=water sub-tags accepted as real water bodies. */
const WATER_BODY_SUBTAGS = new Set([
  'lake', 'pond', 'reservoir', 'river', 'canal', 'oxbow', 'lagoon', 'harbour', 'bay',
])

/** Minimum polygon area for a rendered water body (small backyard ponds stay land). */
export const MIN_WATER_AREA_M2 = 150

/**
 * Returns the whitelist rule that admits these tags as a water AREA, or null.
 * Null means "not water" — the burden of proof is on being water.
 */
export function waterProvenance(tags: Record<string, string>): string | null {
  // hard exclusions regardless of other tags
  if (tags.amenity === 'fountain') return null
  if (tags.leisure === 'swimming_pool' || tags.leisure === 'water_park') return null
  if (tags.natural === 'wetland' || tags.wetland) return null
  if (tags.water && !WATER_BODY_SUBTAGS.has(tags.water)) return null // fountain/pool/basin/wastewater/…
  // covered or underground water is invisible from above
  if ((tags.tunnel && tags.tunnel !== 'no') || tags.covered === 'yes' || tags.location === 'underground') return null

  if (tags.natural === 'water') return tags.water ? `natural=water(${tags.water})` : 'natural=water'
  if (tags.waterway === 'riverbank') return 'waterway=riverbank'
  if (tags.landuse === 'reservoir') return 'landuse=reservoir'
  return null
}

function areaKindFor(tags: Record<string, string>): AreaKind | null {
  if (waterProvenance(tags)) return 'water'
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'forest'
  if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'playground') return 'park'
  if (tags.landuse === 'grass' || tags.natural === 'grassland' || tags.landuse === 'meadow' || tags.leisure === 'pitch') return 'grass'
  if (tags.natural === 'wetland') return 'grass' // wetlands are green, never blue
  if (tags.natural === 'beach' || tags.natural === 'sand') return 'sand'
  if (tags.landuse === 'residential') return 'residential'
  if (tags.landuse === 'commercial') return 'commercial'
  if (tags.landuse === 'retail') return 'retail'
  if (tags.landuse === 'industrial') return 'industrial'
  return null
}

const RENDERED_AREAS = new Set<AreaKind>(['water', 'park', 'grass', 'sand', 'forest'])

// Only large flowing waterways get a buffered surface. Streams, ditches and
// drains are drawn nowhere: at city scale they are curbside features, and the
// worst over-painting came from culverted small waterways crossing blocks.
const WATERWAY_WIDTH: Record<string, number> = { river: 30, canal: 14 }

/** Buffer a waterway centerline into a water polygon ring. */
function waterwayRing(pts: Vec2[], width: number): Vec2[] | null {
  if (pts.length < 2) return null
  const left = offsetPolyline(pts, width / 2)
  const right = offsetPolyline(pts, -width / 2)
  return [...left, ...right.reverse()]
}

/**
 * Assemble sea surfaces from natural=coastline ways.
 *
 * OSM coastline direction is consistent: LAND on the left of the way, WATER on
 * the right. We reconstruct the LAND polygons — each open coastline run closed
 * along the scene-rectangle boundary on its land side, plus any closed
 * coastline loops (islands fully in view) — union them, and take the sea as
 * `rect − land` via a robust polygon boolean. This handles every coastal case a
 * single half-plane closure could not: straits (water between two facing
 * shores, e.g. the Golden Gate), bays, archipelagos, and interior islands
 * (emitted as holes so they stay land). Each resulting sea polygon must be
 * simple, above the minimum area, and — the load-bearing safety guard — must
 * cover essentially no building centroids (buildings are land). A basin that
 * would flood buildings is dropped; if none survive, NO sea is painted. Land is
 * the default base and under-painting beats flooding a city.
 */
export interface SeaPolygon {
  ring: Vec2[]
  holes: Vec2[][]
}
export function assembleSea(
  chains: Vec2[][],
  buildingCentroids: Vec2[],
  rect: Rect,
): { polys: SeaPolygon[]; buildingsInside: number } | null {
  if (!chains.length) return null
  const merged = mergeCoastlineChains(chains)

  // ---- reconstruct land polygons (island loops + land-side closures of runs)
  const landPolys: Vec2[][] = []
  for (const chain of merged) {
    if (chain.length < 3) continue
    const isLoop =
      Math.hypot(chain[0].x - chain[chain.length - 1].x, chain[0].z - chain[chain.length - 1].z) < 2
    if (isLoop) {
      const loop = clipRingToRect(chain.slice(0, chain.length - 1), rect)
      if (loop.length >= 3 && ringAreaM2(loop) > 1) landPolys.push(loop)
      continue
    }
    for (const run of runsInsideRect(chain, rect)) {
      const land = landClosure(run, rect)
      if (land) landPolys.push(land)
    }
  }
  if (!landPolys.length) return null

  // ---- sea = rect − union(land) via robust polygon boolean
  const rectRing: ClipRing = [
    [rect.minX, rect.minZ], [rect.maxX, rect.minZ],
    [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ], [rect.minX, rect.minZ],
  ]
  let seaMP: ReturnType<typeof polygonClipping.difference>
  try {
    seaMP = polygonClipping.difference([rectRing], ...landPolys.map((r) => [ringToClip(r)]))
  } catch {
    return null // degenerate coastline input — under-paint rather than risk a bad ring
  }

  const maxAllowed = Math.max(2, Math.ceil(buildingCentroids.length * 0.01))
  const polys: SeaPolygon[] = []
  let totalInside = 0
  for (const poly of seaMP) {
    const ring = clipToRing(poly[0])
    if (ring.length < 3 || !ringIsSimple(ring)) continue
    const holes = poly.slice(1).map(clipToRing).filter((h) => h.length >= 3)
    const areaM2 = ringAreaM2(ring) - holes.reduce((s, h) => s + ringAreaM2(h), 0)
    if (areaM2 < MIN_WATER_AREA_M2) continue
    const inside = buildingCentroids.reduce(
      (n, c) => n + (pointInRing(c, ring) && !holes.some((h) => pointInRing(c, h)) ? 1 : 0),
      0,
    )
    if (inside > maxAllowed) continue // this basin would flood buildings — drop it, keep land
    polys.push({ ring, holes })
    totalInside += inside
  }
  polys.sort((a, b) => ringAreaM2(b.ring) - ringAreaM2(a.ring))
  return polys.length ? { polys, buildingsInside: totalInside } : null
}

const ringToClip = (r: Vec2[]): ClipRing => {
  const xy: ClipRing = r.map((p) => [p.x, p.z])
  xy.push([r[0].x, r[0].z]) // polygon-clipping wants closed rings
  return xy
}
const clipToRing = (r: ClipRing): Vec2[] => {
  const out = r.map(([x, z]) => ({ x, z }))
  const n = out.length
  if (n > 1 && Math.abs(out[0].x - out[n - 1].x) < 1e-6 && Math.abs(out[0].z - out[n - 1].z) < 1e-6) out.pop()
  return out
}

/** Merge coastline ways end-to-start into maximal chains (land-left/water-right preserved). */
function mergeCoastlineChains(chains: Vec2[][]): Vec2[][] {
  const pool = chains.map((c) => [...c])
  const merged: Vec2[][] = []
  while (pool.length) {
    let cur = pool.shift()!
    let extended = true
    while (extended) {
      extended = false
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i]
        const end = cur[cur.length - 1]
        if (Math.hypot(cand[0].x - end.x, cand[0].z - end.z) < 2) {
          cur = cur.concat(cand.slice(1))
          pool.splice(i, 1)
          extended = true
          break
        }
      }
    }
    merged.push(cur)
  }
  return merged
}

/** Every contiguous piece of the polyline inside the rect, each with both ends on the boundary. */
function runsInsideRect(chain: Vec2[], rect: Rect): Vec2[][] {
  const inside = (p: Vec2) => p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ
  const runs: Vec2[][] = []
  let cur: Vec2[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const clipped = clipSegmentToRect(chain[i], chain[i + 1], rect)
    if (!clipped) {
      if (cur.length >= 2) runs.push(cur)
      cur = []
      continue
    }
    const [p, q] = clipped
    if (cur.length === 0) cur.push(p)
    else {
      const last = cur[cur.length - 1]
      if (Math.hypot(p.x - last.x, p.z - last.z) > 0.01) {
        // segment re-entered elsewhere: previous run ended
        if (cur.length >= 2) runs.push(cur)
        cur = [p]
      }
    }
    cur.push(q)
    if (!inside(chain[i + 1])) {
      if (cur.length >= 2) runs.push(cur)
      cur = []
    }
  }
  if (cur.length >= 2) runs.push(cur)

  const out: Vec2[][] = []
  for (const r of runs) {
    const run = r.map((p) => ({ ...p }))
    // dangling interior endpoints (coastline data cut inside the rect): extend along the end tangent to the boundary
    let ok = true
    for (const atEnd of [false, true]) {
      const e = atEnd ? run[run.length - 1] : run[0]
      if (onBoundary(e, rect)) continue
      const nb = atEnd ? run[run.length - 2] : run[1]
      const ext = rayToRect(e, { x: e.x - nb.x, z: e.z - nb.z }, rect)
      if (!ext) { ok = false; break }
      if (atEnd) run.push(ext)
      else run.unshift(ext)
    }
    if (ok && run.length >= 2) out.push(run)
  }
  return out
}

/** Close an open coastline run into the LAND polygon (land is left of way direction). */
function landClosure(run: Vec2[], rect: Rect): Vec2[] | null {
  const mi = Math.floor(run.length / 2)
  const a = run[Math.max(mi - 1, 0)]
  const b = run[Math.min(mi + 1, run.length - 1)]
  const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1
  // water sits on the RIGHT of way direction (-dz, dx); LAND is the opposite side
  const landProbe: Vec2 = {
    x: (a.x + b.x) / 2 + ((b.z - a.z) / dl) * 20,
    z: (a.z + b.z) / 2 - ((b.x - a.x) / dl) * 20,
  }
  for (const dir of [1, -1] as const) {
    const ring = closeAlongBoundary(run, rect, dir)
    if (ring && ring.length >= 3 && ringIsSimple(ring) && pointInRing(landProbe, ring)) return ring
  }
  return null
}

function onBoundary(p: Vec2, rect: Rect, eps = 0.01): boolean {
  return (
    Math.abs(p.x - rect.minX) < eps || Math.abs(p.x - rect.maxX) < eps ||
    Math.abs(p.z - rect.minZ) < eps || Math.abs(p.z - rect.maxZ) < eps
  )
}

/** Liang–Barsky: portion of segment ab inside rect, or null. */
function clipSegmentToRect(a: Vec2, b: Vec2, rect: Rect): [Vec2, Vec2] | null {
  const dx = b.x - a.x
  const dz = b.z - a.z
  let t0 = 0
  let t1 = 1
  const clips: [number, number][] = [
    [-dx, a.x - rect.minX], [dx, rect.maxX - a.x],
    [-dz, a.z - rect.minZ], [dz, rect.maxZ - a.z],
  ]
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  const at = (t: number): Vec2 => ({ x: a.x + dx * t, z: a.z + dz * t })
  return [at(t0), at(t1)]
}

/** First intersection of a ray from inside the rect with the rect boundary. */
function rayToRect(from: Vec2, dir: Vec2, rect: Rect): Vec2 | null {
  const l = Math.hypot(dir.x, dir.z)
  if (l < 1e-9) return null
  const dx = dir.x / l
  const dz = dir.z / l
  let tMin = Infinity
  if (dx > 1e-12) tMin = Math.min(tMin, (rect.maxX - from.x) / dx)
  if (dx < -1e-12) tMin = Math.min(tMin, (rect.minX - from.x) / dx)
  if (dz > 1e-12) tMin = Math.min(tMin, (rect.maxZ - from.z) / dz)
  if (dz < -1e-12) tMin = Math.min(tMin, (rect.minZ - from.z) / dz)
  if (!isFinite(tMin) || tMin < 0) return null
  return { x: from.x + dx * tMin, z: from.z + dz * tMin }
}

/** Perimeter coordinate of a boundary point (clockwise from the min corner). */
function perimT(p: Vec2, rect: Rect): number {
  const w = rect.maxX - rect.minX
  const h = rect.maxZ - rect.minZ
  const dMinZ = Math.abs(p.z - rect.minZ)
  const dMaxX = Math.abs(p.x - rect.maxX)
  const dMaxZ = Math.abs(p.z - rect.maxZ)
  const dMinX = Math.abs(p.x - rect.minX)
  const m = Math.min(dMinZ, dMaxX, dMaxZ, dMinX)
  if (m === dMinZ) return p.x - rect.minX
  if (m === dMaxX) return w + (p.z - rect.minZ)
  if (m === dMaxZ) return w + h + (rect.maxX - p.x)
  return w + h + w + (rect.maxZ - p.z)
}

/** Close an open run whose ends sit on the rect boundary by walking the boundary. */
function closeAlongBoundary(run: Vec2[], rect: Rect, dir: 1 | -1): Vec2[] | null {
  const w = rect.maxX - rect.minX
  const h = rect.maxZ - rect.minZ
  const P = 2 * (w + h)
  const corners: { t: number; p: Vec2 }[] = [
    { t: 0, p: { x: rect.minX, z: rect.minZ } },
    { t: w, p: { x: rect.maxX, z: rect.minZ } },
    { t: w + h, p: { x: rect.maxX, z: rect.maxZ } },
    { t: w + h + w, p: { x: rect.minX, z: rect.maxZ } },
  ]
  const tEnd = perimT(run[run.length - 1], rect)
  const tStart = perimT(run[0], rect)
  const ring = [...run]
  // walk from tEnd toward tStart in direction dir, inserting corners passed
  let span = dir === 1 ? (tStart - tEnd + P) % P : (tEnd - tStart + P) % P
  if (span < 1e-6) span = P
  const passed = corners
    .map((c) => ({ ...c, d: dir === 1 ? (c.t - tEnd + P) % P : (tEnd - c.t + P) % P }))
    .filter((c) => c.d > 1e-6 && c.d < span - 1e-6)
    .sort((c1, c2) => c1.d - c2.d)
  for (const c of passed) ring.push(c.p)
  return ring
}

const LANE_WIDTH_M = 3.3
const METERS_PER_DEG_LAT = 111320

function parseMeters(v?: string): number | undefined {
  if (!v) return undefined
  const m = v.match(/([\d.]+)/)
  if (!m) return undefined
  const n = parseFloat(m[1])
  if (!isFinite(n) || n <= 0) return undefined
  if (v.includes("'") || v.toLowerCase().includes('ft')) return n * 0.3048
  return n
}

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

export function ingestOverpass(raw: { elements: OsmElement[] }, cityName: string): CityGraph {
  const elements = raw.elements
  // compute origin = centroid of all way geometry
  let latSum = 0
  let lngSum = 0
  let n = 0
  for (const el of elements) {
    if (el.type === 'way' && el.geometry) {
      for (const g of el.geometry) {
        latSum += g.lat
        lngSum += g.lon
        n++
      }
    }
  }
  const origin = { lat: latSum / Math.max(n, 1), lng: lngSum / Math.max(n, 1) }
  const mPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)

  // local ENU frame: x = east (m), z = south (m) so that north is -z in three.js
  const toLocal = (lat: number, lon: number): Vec2 => ({
    x: (lon - origin.lng) * mPerDegLng,
    z: -(lat - origin.lat) * METERS_PER_DEG_LAT,
  })

  const buildings: BuildingFeature[] = []
  const roads: RoadSegment[] = []
  const areas: AreaFeature[] = []
  const barriers: BarrierFeature[] = []
  const points: PointFeature[] = []
  const coastlineChains: Vec2[][] = []

  let bS = Infinity, bW = Infinity, bN = -Infinity, bE = -Infinity
  const growBbox = (lat: number, lon: number) => {
    bS = Math.min(bS, lat); bN = Math.max(bN, lat)
    bW = Math.min(bW, lon); bE = Math.max(bE, lon)
  }

  const NODE_KINDS: [string, string, PointFeature['kind']][] = [
    ['highway', 'traffic_signals', 'traffic_signal'],
    ['natural', 'tree', 'tree'],
    ['highway', 'street_lamp', 'street_lamp'],
    ['amenity', 'bench', 'bench'],
    ['amenity', 'waste_basket', 'waste_basket'],
    ['amenity', 'fountain', 'fountain'],
    ['highway', 'bus_stop', 'bus_stop'],
    ['historic', 'memorial', 'statue'],
    ['historic', 'monument', 'statue'],
    ['tourism', 'artwork', 'statue'],
  ]

  const addPoint = (id: number, kind: PointFeature['kind'], lat: number, lon: number, tags: Record<string, string>) => {
    growBbox(lat, lon)
    points.push({
      id: `${kind}_${id}`,
      kind,
      position: toLocal(lat, lon),
      lat,
      lng: lon,
      name: tags.name,
      wikidata: tags.wikidata,
    })
  }

  for (const el of elements) {
    if (el.type === 'node' && el.tags) {
      for (const [k, v, kind] of NODE_KINDS) {
        if (el.tags[k] === v) {
          addPoint(el.id, kind, el.lat!, el.lon!, el.tags)
          break
        }
      }
      continue
    }
    if (el.type !== 'way' || !el.tags || !el.geometry || el.geometry.length < 2) continue
    for (const g of el.geometry) growBbox(g.lat, g.lon)

    // coastline / rivers / fences / mapped-as-area fountains & statues
    if (el.tags.natural === 'coastline') {
      coastlineChains.push(el.geometry.map((g) => toLocal(g.lat, g.lon)))
      continue
    }
    const ww = el.tags.waterway
    if (ww && WATERWAY_WIDTH[ww] !== undefined) {
      // culverted / covered / underground waterways cross city blocks invisibly —
      // painting them was a major source of blue stripes through streets
      const layerTag = el.tags.layer ? parseFloat(el.tags.layer) || 0 : 0
      if ((el.tags.tunnel && el.tags.tunnel !== 'no') || el.tags.covered === 'yes' || layerTag < 0) continue
      const width = parseMeters(el.tags.width) ?? WATERWAY_WIDTH[ww]
      const ring = waterwayRing(el.geometry.map((g) => toLocal(g.lat, g.lon)), width)
      if (ring) {
        const areaM2 = ringAreaM2(ring)
        if (areaM2 >= MIN_WATER_AREA_M2) {
          areas.push({ id: `water_${el.id}`, kind: 'water', ring, render: true, areaM2, provenance: `waterway=${ww}` })
        }
      }
      continue
    }
    // riverbank is an AREA tag handled by areaKindFor below; every other
    // unbuffered waterway (stream/ditch/drain/…) is never a water surface
    if (ww && ww !== 'riverbank') continue
    if (el.tags.barrier === 'fence' || el.tags.barrier === 'wall') {
      barriers.push({
        id: `bar_${el.id}`,
        kind: el.tags.barrier,
        points: el.geometry.map((g) => toLocal(g.lat, g.lon)),
      })
      continue
    }
    if (el.tags.amenity === 'fountain' || el.tags.historic === 'memorial' || el.tags.historic === 'monument' || el.tags.tourism === 'artwork') {
      // mapped as an area — collapse to its centroid
      let clat = 0
      let clon = 0
      for (const g of el.geometry) {
        clat += g.lat
        clon += g.lon
      }
      addPoint(el.id, el.tags.amenity === 'fountain' ? 'fountain' : 'statue', clat / el.geometry.length, clon / el.geometry.length, el.tags)
      continue
    }

    if (el.tags.building) {
      const ring = el.geometry.map((g) => toLocal(g.lat, g.lon))
      // drop closing duplicate point
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) ring.pop()
      if (ring.length < 3) continue

      const heightTag = parseMeters(el.tags.height ?? el.tags['building:height'])
      const levels = el.tags['building:levels']
        ? parseFloat(el.tags['building:levels'])
        : undefined
      let heightM: number
      let heightSource: BuildingFeature['heightSource']
      if (heightTag) {
        heightM = heightTag
        heightSource = 'height-tag'
      } else if (levels && isFinite(levels) && levels > 0) {
        heightM = levels * 3.2
        heightSource = 'levels'
      } else {
        heightM = 9 + Math.round(hashSeed(`h${el.id}`) * 5) * 3.2
        heightSource = 'estimated'
      }

      let cx = 0
      let cz = 0
      let clat = 0
      let clng = 0
      for (const g of el.geometry) {
        clat += g.lat
        clng += g.lon
      }
      clat /= el.geometry.length
      clng /= el.geometry.length
      for (const p of ring) {
        cx += p.x
        cz += p.z
      }

      const name = el.tags.name
      const wikidata = el.tags.wikidata
      const tier: BuildingFeature['tier'] = name
        ? heightM >= 70 || wikidata || el.tags.tourism || el.tags.historic
          ? 'landmark'
          : 'notable'
        : 'generic'

      buildings.push({
        id: `bld_${el.id}`,
        name,
        footprint: ring,
        heightM,
        levels: levels && isFinite(levels) ? levels : undefined,
        heightSource,
        tier,
        lat: clat,
        lng: clng,
        wikidata,
        tags: el.tags,
      })
      continue
    }

    const areaKind = !el.tags.highway && !el.tags.building ? areaKindFor(el.tags) : null
    if (areaKind) {
      const ring = el.geometry.map((g) => toLocal(g.lat, g.lon))
      if (ring.length >= 4) {
        if (areaKind === 'water') {
          // water polygons must be CLOSED (unclosed ways are multipolygon
          // fragments — implicitly closing them floods arbitrary land), simple,
          // and above the minimum area
          const first = ring[0]
          const last = ring[ring.length - 1]
          const closed = Math.hypot(first.x - last.x, first.z - last.z) < 1
          const areaM2 = ringAreaM2(ring)
          if (!closed || areaM2 < MIN_WATER_AREA_M2 || !ringIsSimple(ring)) continue
          areas.push({
            id: `area_${el.id}`, kind: 'water', ring, render: true,
            areaM2, provenance: waterProvenance(el.tags)!,
          })
        } else {
          areas.push({ id: `area_${el.id}`, kind: areaKind, ring, render: RENDERED_AREAS.has(areaKind) })
        }
      }
      continue
    }

    const hw = el.tags.highway as RoadClass | undefined
    if (hw && ROAD_CLASSES.includes(hw)) {
      const pts = el.geometry.map((g) => toLocal(g.lat, g.lon))
      const lanesTag = el.tags.lanes ? parseFloat(el.tags.lanes) : undefined
      const lanes = lanesTag && isFinite(lanesTag) ? lanesTag : CLASS_LANES[hw]
      const widthTag = parseMeters(el.tags.width)
      const widthM = widthTag ?? (lanes > 0 ? Math.max(lanes * LANE_WIDTH_M, 4) : CLASS_WIDTH[hw])
      const mid = el.geometry[Math.floor(el.geometry.length / 2)]
      const layer = el.tags.layer ? parseFloat(el.tags.layer) || 0 : 0
      roads.push({
        id: `road_${el.id}`,
        name: el.tags.name,
        roadClass: hw,
        points: pts,
        widthM: Math.min(widthM, 30),
        lanes,
        oneway: el.tags.oneway === 'yes',
        bridge: el.tags.bridge === 'yes' || el.tags.bridge === 'viaduct',
        tunnel: el.tags.tunnel === 'yes' || el.tags.tunnel === 'building_passage',
        layer,
        surfaceTag: el.tags.surface,
        structure: el.tags['bridge:structure'],
        wikidata: el.tags.wikidata,
        centerLat: mid.lat,
        centerLng: mid.lon,
      })
    }
  }

  // ---- sea from coastline ways (clipped to scene rect, closed along its boundary)
  if (coastlineChains.length && isFinite(bS)) {
    const centroids = buildings.map((b) => {
      let x = 0, z = 0
      for (const p of b.footprint) { x += p.x; z += p.z }
      return { x: x / b.footprint.length, z: z / b.footprint.length }
    })
    const pad = 120
    const nw = toLocal(bN, bW)
    const se = toLocal(bS, bE)
    const rect: Rect = {
      minX: nw.x - pad, maxX: se.x + pad,
      minZ: nw.z - pad, maxZ: se.z + pad,
    }
    const sea = assembleSea(coastlineChains, centroids, rect)
    if (sea) {
      sea.polys.forEach((p, i) => {
        areas.push({
          id: i === 0 ? 'water_sea' : `water_sea_${i}`,
          kind: 'water',
          ring: p.ring,
          holes: p.holes.length ? p.holes : undefined,
          render: true,
          areaM2: ringAreaM2(p.ring) - p.holes.reduce((s, h) => s + ringAreaM2(h), 0),
          provenance: 'natural=coastline',
        })
      })
    }
  }

  return {
    cityName,
    origin,
    bboxLatLng: isFinite(bS)
      ? { south: bS, west: bW, north: bN, east: bE }
      : { south: origin.lat, west: origin.lng, north: origin.lat, east: origin.lng },
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL 1.0',
    roads,
    buildings,
    areas,
    barriers,
    points,
    report: {
      buildingCount: buildings.length,
      buildingsWithHeight: buildings.filter((b) => b.heightSource !== 'estimated').length,
      namedBuildings: buildings.filter((b) => b.name).length,
      roadCount: roads.length,
      roadsWithLanes: roads.length, // lanes always resolved (tag or class default)
      signalCount: points.filter((p) => p.kind === 'traffic_signal').length,
      treeCount: points.filter((p) => p.kind === 'tree').length,
    },
  }
}
