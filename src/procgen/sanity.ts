import type { BuildingFeature, CityGraph, RoadClass, RoadSegment, Vec2 } from '../types'
import { pointInRing, polylineLength, ringAreaM2, ringIsSimple } from './geometry'
import { BRIDGE_LAYER_H, NON_DRIVABLE } from './roadNetwork'

// ---------------------------------------------------------------------------
// Deterministic "city sanity" validation + auto-remediation.
//
// Runs on the CityGraph BEFORE any geometry is built and removes / clamps /
// flags placements that could never occur in a real city (buildings sitting on
// a driving lane, sub-metre "roads", 3 km-tall slivers, duplicated OSM ways,
// footprints under an elevated bridge deck, …). Everything here is pure and
// node-safe: no DOM, no THREE materials, no Math.random, no Date.now — the same
// input graph always yields the same sanitised graph and the same report.
//
// Complexity: O(n) with a local uniform spatial grid for the building↔road and
// building↔building broad-phases (same idea as CarriagewayIndex in props.ts,
// re-implemented tiny and locally so this module never imports the renderer).
// ---------------------------------------------------------------------------

export interface SanityIssue {
  rule: string
  severity: 'error' | 'warn'
  entityKind: 'building' | 'road'
  entityId: string
  message: string
  action: 'dropped' | 'clamped' | 'adjusted' | 'flagged'
}

export interface SanityReport {
  issues: SanityIssue[]
  counts: Record<string, number>
}

export interface SanityResult {
  graph: CityGraph
  report: SanityReport
}

// ---- tunables (all metres) ------------------------------------------------

const MIN_FOOTPRINT_AREA = 4 // m² — below this a "building" is noise
const MIN_ROAD_LENGTH = 1 // m — below this a "road" is noise
const MAX_HEIGHT = 700 // m — taller than any building on earth
const MIN_HEIGHT = 2 // m — clamp floor for non-positive heights
const ABSURD_WIDTH = 100 // m — wider than any real carriageway
const BOUNDS_MARGIN = 250 // m — slack around the road extent for out-of-bounds
const DEDUPE_CENTROID_TOL = 1.0 // m — building centroid coincidence
const DEDUPE_AREA_TOL = 0.05 // 5% — building area coincidence
const ROAD_COINCIDENCE_TOL = 2.0 // m — duplicate-road endpoint/mid coincidence
const OVERLAP_FRACTION = 0.5 // >50% of the smaller footprint inside the larger
const DECK_THICKNESS = 1.0 // m — a bridge deck this thick; soffit = deckElev − this

// Per-class carriageway width clamp: [max, default]. `default` replaces a
// non-positive width; `max` caps an absurd (>ABSURD_WIDTH) width.
const WIDTH_BY_CLASS: Record<RoadClass, [max: number, def: number]> = {
  motorway: [60, 24],
  trunk: [50, 20],
  primary: [40, 16],
  secondary: [36, 14],
  tertiary: [30, 12],
  residential: [24, 9],
  unclassified: [24, 9],
  living_street: [20, 7],
  pedestrian: [30, 6],
  service: [16, 5],
  footway: [10, 2],
  cycleway: [10, 2.5],
}

// ---- small pure geometry helpers ------------------------------------------

function centroidOf(ring: Vec2[]): Vec2 {
  let x = 0
  let z = 0
  for (const p of ring) {
    x += p.x
    z += p.z
  }
  return { x: x / ring.length, z: z / ring.length }
}

interface Bbox {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function bboxOf(ring: Vec2[]): Bbox {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of ring) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return { minX, maxX, minZ, maxZ }
}

function isFiniteVec(p: Vec2): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.z)
}

/** Distance from point q to segment a→b in the XZ plane. */
function pointSegDist(q: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  let t = len2 > 1e-9 ? ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const px = a.x + dx * t
  const pz = a.z + dz * t
  return Math.hypot(q.x - px, q.z - pz)
}

function bboxOverlap(a: Bbox, b: Bbox): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ)
}

// ---- local uniform spatial grid for drivable carriageways -----------------
// Mirrors CarriagewayIndex in props.ts, re-implemented here so sanity.ts stays
// free of any renderer import. Each cell holds the carriageway segments whose
// (half-width-padded) bbox touches it; a point query only scans nearby cells.

interface CarriagewaySeg {
  ax: number
  az: number
  bx: number
  bz: number
  half: number
  id: string
}

class DrivableGrid {
  private cells = new Map<string, CarriagewaySeg[]>()
  private static CELL = 24

  /** Index drivable, at-grade (non-bridge, non-tunnel) road carriageways. */
  constructor(roads: RoadSegment[]) {
    for (const r of roads) {
      if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.bridge) continue
      if (r.points.length < 2) continue
      const half = Math.max(r.widthM, 0) / 2
      for (let i = 1; i < r.points.length; i++) {
        this.insert(r.points[i - 1], r.points[i], half, r.id)
      }
    }
  }

  private insert(a: Vec2, b: Vec2, half: number, id: string): void {
    const C = DrivableGrid.CELL
    const pad = half + 1
    const minX = Math.min(a.x, b.x) - pad
    const maxX = Math.max(a.x, b.x) + pad
    const minZ = Math.min(a.z, b.z) - pad
    const maxZ = Math.max(a.z, b.z) + pad
    for (let cx = Math.floor(minX / C); cx <= Math.floor(maxX / C); cx++) {
      for (let cz = Math.floor(minZ / C); cz <= Math.floor(maxZ / C); cz++) {
        const key = `${cx},${cz}`
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, half, id })
      }
    }
  }

  /** True when p lies inside any drivable carriageway (centerline ± half+margin). */
  inside(p: Vec2, margin = 0): boolean {
    const C = DrivableGrid.CELL
    const key = `${Math.floor(p.x / C)},${Math.floor(p.z / C)}`
    const list = this.cells.get(key)
    if (!list) return false
    for (const s of list) {
      if (pointSegDist(p, { x: s.ax, z: s.az }, { x: s.bx, z: s.bz }) < s.half + margin) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

/**
 * Validate & auto-remediate a CityGraph. Returns a NEW graph (the input is never
 * mutated) with impossible entities dropped / clamped / flagged, plus a report.
 *
 * Rule order matters: roads are cleaned first (so building checks run against
 * the real carriageways); then buildings are checked degenerate → bounds →
 * height → on-carriageway → under-bridge → duplicate → overlap, so entities that
 * are about to be dropped never spawn spurious overlap/duplicate issues; finally
 * road-through-building is flagged over the surviving buildings.
 */
export function sanitizeCity(graph: CityGraph): SanityResult {
  const issues: SanityIssue[] = []
  const record = (i: SanityIssue) => issues.push(i)

  const inRoads = graph.roads ?? []
  const inBuildings = graph.buildings ?? []

  // ===== ROADS ============================================================
  const roads = sanitizeRoads(inRoads, record)

  // Scene bounds derived from the surviving road extent (+margin); fall back to
  // building footprints when there are no roads.
  const bounds = deriveBounds(roads, inBuildings)

  // ===== BUILDINGS ========================================================
  const drivable = new DrivableGrid(roads)
  // Elevated bridge decks (bridge && layer>=1) for the under-deck check.
  const bridgeDecks = inRoads
    .filter((r) => r.bridge && !NON_DRIVABLE.has(r.roadClass) && r.points.length >= 2)
    .map((r) => ({ road: r, deckElev: Math.max(r.layer, 1) * BRIDGE_LAYER_H }))

  const buildings = sanitizeBuildings(inBuildings, { drivable, bridgeDecks, bounds }, record)

  // ===== ROAD ↔ SURVIVING BUILDING (flag only) ============================
  flagRoadsThroughBuildings(roads, buildings, record)

  // ===== assemble the new graph (shallow-clone, replace the two arrays) ====
  const outGraph: CityGraph = {
    ...graph,
    roads,
    buildings,
    report: { ...graph.report, buildingCount: buildings.length, roadCount: roads.length },
  }

  const counts: Record<string, number> = {}
  for (const i of issues) counts[i.rule] = (counts[i.rule] ?? 0) + 1

  return { graph: outGraph, report: { issues, counts } }
}

// ---------------------------------------------------------------------------
// ROAD rules
// ---------------------------------------------------------------------------

function sanitizeRoads(inRoads: RoadSegment[], record: (i: SanityIssue) => void): RoadSegment[] {
  const kept: RoadSegment[] = []
  // duplicate-road: canonical signature keyed on (sorted endpoints, length).
  const seen = new Map<string, string>()

  for (const r of inRoads) {
    const id = r.id
    const pts = r.points ?? []

    // 10. invalid-coords — any NaN/Infinity in points. Drop.
    if (pts.some((p) => !isFiniteVec(p))) {
      record({
        rule: 'invalid-coords',
        severity: 'error',
        entityKind: 'road',
        entityId: id,
        message: 'road centerline contains NaN/Infinity coordinates',
        action: 'dropped',
      })
      continue
    }

    // 8. degenerate-road — <2 distinct points or total length < ~1 m. Drop.
    const distinct = dedupeConsecutive(pts)
    if (distinct.length < 2 || polylineLength(distinct) < MIN_ROAD_LENGTH) {
      record({
        rule: 'degenerate-road',
        severity: 'error',
        entityKind: 'road',
        entityId: id,
        message: `road is degenerate (${distinct.length} distinct pts, ${polylineLength(distinct).toFixed(2)} m long)`,
        action: 'dropped',
      })
      continue
    }

    // 11. duplicate-road — same near-coincident polyline as an earlier road. Dedupe.
    const sig = roadSignature(distinct)
    const prior = seen.get(sig)
    if (prior) {
      record({
        rule: 'duplicate-road',
        severity: 'warn',
        entityKind: 'road',
        entityId: id,
        message: `road duplicates ${prior} (coincident polyline)`,
        action: 'dropped',
      })
      continue
    }
    seen.set(sig, id)

    // clone (never mutate input); write back the de-duplicated point list
    const out: RoadSegment = { ...r, points: distinct }

    // 9. absurd-width — widthM<=0 or >ABSURD_WIDTH. Clamp to sane range by class.
    const [maxW, defW] = WIDTH_BY_CLASS[r.roadClass] ?? [ABSURD_WIDTH, 8]
    if (!(out.widthM > 0)) {
      record({
        rule: 'absurd-width',
        severity: 'warn',
        entityKind: 'road',
        entityId: id,
        message: `road width ${out.widthM} m is non-positive → clamped to ${defW} m (${r.roadClass})`,
        action: 'clamped',
      })
      out.widthM = defW
    } else if (out.widthM > ABSURD_WIDTH) {
      record({
        rule: 'absurd-width',
        severity: 'warn',
        entityKind: 'road',
        entityId: id,
        message: `road width ${out.widthM} m is absurd → clamped to ${maxW} m (${r.roadClass})`,
        action: 'clamped',
      })
      out.widthM = maxW
    }

    // 13. zero-lane-drivable — a drivable road with no lanes. Adjust to a default.
    if (!NON_DRIVABLE.has(out.roadClass) && !(out.lanes > 0)) {
      const def = out.oneway ? 1 : 2
      record({
        rule: 'zero-lane-drivable',
        severity: 'warn',
        entityKind: 'road',
        entityId: id,
        message: `drivable road has ${out.lanes} lanes → set to ${def}`,
        action: 'adjusted',
      })
      out.lanes = def
    }

    kept.push(out)
  }
  return kept
}

/** Drop consecutive near-coincident points (< 5 cm apart). */
function dedupeConsecutive(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.05) out.push(p)
  }
  return out
}

/** Direction-agnostic signature: quantised {sorted endpoints, length}. */
function roadSignature(pts: Vec2[]): string {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const q = (n: number) => Math.round(n / ROAD_COINCIDENCE_TOL)
  const ea = `${q(a.x)},${q(a.z)}`
  const eb = `${q(b.x)},${q(b.z)}`
  const [lo, hi] = ea <= eb ? [ea, eb] : [eb, ea]
  return `${lo}|${hi}|${Math.round(polylineLength(pts) / ROAD_COINCIDENCE_TOL)}`
}

// ---------------------------------------------------------------------------
// BUILDING rules
// ---------------------------------------------------------------------------

interface BuildingCtx {
  drivable: DrivableGrid
  bridgeDecks: { road: RoadSegment; deckElev: number }[]
  bounds: Bbox
}

interface LiveBuilding {
  b: BuildingFeature
  centroid: Vec2
  bbox: Bbox
  area: number
}

function sanitizeBuildings(
  inBuildings: BuildingFeature[],
  ctx: BuildingCtx,
  record: (i: SanityIssue) => void,
): BuildingFeature[] {
  const live: LiveBuilding[] = []

  for (const b of inBuildings) {
    const fp = b.footprint ?? []

    // 3. degenerate-footprint — <3 pts, non-simple ring, or area < ~4 m². Drop.
    if (fp.some((p) => !isFiniteVec(p))) {
      record(dropBuilding(b.id, 'degenerate-footprint', 'footprint has non-finite coordinates'))
      continue
    }
    if (fp.length < 3 || !ringIsSimple(fp)) {
      record(dropBuilding(b.id, 'degenerate-footprint', `footprint is degenerate (${fp.length} pts / self-intersecting)`))
      continue
    }
    const area = ringAreaM2(fp)
    if (area < MIN_FOOTPRINT_AREA) {
      record(dropBuilding(b.id, 'degenerate-footprint', `footprint area ${area.toFixed(2)} m² < ${MIN_FOOTPRINT_AREA} m²`))
      continue
    }

    const centroid = centroidOf(fp)
    const bbox = bboxOf(fp)

    // 6. out-of-bounds — footprint entirely outside the scene bounds. Drop.
    if (!bboxOverlap(bbox, ctx.bounds)) {
      record(dropBuilding(b.id, 'out-of-bounds', 'footprint lies entirely outside the scene bounds'))
      continue
    }

    // clone; clamp height in place on the clone (never mutate the input)
    const out: BuildingFeature = { ...b, footprint: fp }

    // 4. absurd-height — heightM<=0 or >700, or an impossible sliver. Clamp.
    const minExtent = Math.min(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ)
    const height = clampHeight(out.heightM, minExtent, b.id, record)
    out.heightM = height

    // 1. building-on-carriageway — centroid + majority of footprint on a
    //    drivable, at-grade carriageway. Drop.
    if (onCarriageway(fp, centroid, ctx.drivable)) {
      record(dropBuilding(b.id, 'building-on-carriageway', 'footprint sits on a drivable carriageway'))
      continue
    }

    // 5. building-under-bridge-deck — footprint under an elevated deck that
    //    would pass through the building's height. Drop.
    const deck = underBridgeDeck(centroid, out.heightM, ctx.bridgeDecks)
    if (deck) {
      record(
        dropBuilding(
          b.id,
          'building-under-bridge-deck',
          `footprint under bridge ${deck.road.id} (deck ${deck.deckElev.toFixed(1)} m); building rises to ${out.heightM.toFixed(1)} m`,
        ),
      )
      continue
    }

    live.push({ b: out, centroid, bbox, area })
  }

  // 7. duplicate-building — near-identical centroid + area. Dedupe.
  //    Runs after the drops above so removed buildings can't create phantom dups.
  const afterDup = dedupeBuildings(live, record)

  // 2. building-overlaps-building — >50% of the smaller footprint inside the
  //    larger. Drop the lower-priority one.
  const survivors = resolveOverlaps(afterDup, record)

  return survivors.map((l) => l.b)
}

function dropBuilding(id: string, rule: string, message: string): SanityIssue {
  return { rule, severity: 'error', entityKind: 'building', entityId: id, message, action: 'dropped' }
}

function clampHeight(
  h: number,
  minExtent: number,
  id: string,
  record: (i: SanityIssue) => void,
): number {
  // impossible sliver: a tall tower on a razor-thin footprint (aspect > 40:1)
  const isSliver = minExtent > 0 && h / minExtent > 40 && h > 30
  if (!(h > 0)) {
    record({
      rule: 'absurd-height',
      severity: 'warn',
      entityKind: 'building',
      entityId: id,
      message: `height ${h} m is non-positive → clamped to ${MIN_HEIGHT} m`,
      action: 'clamped',
    })
    return MIN_HEIGHT
  }
  if (h > MAX_HEIGHT) {
    record({
      rule: 'absurd-height',
      severity: 'warn',
      entityKind: 'building',
      entityId: id,
      message: `height ${h} m > ${MAX_HEIGHT} m → clamped`,
      action: 'clamped',
    })
    return MAX_HEIGHT
  }
  if (isSliver) {
    const clamped = Math.max(MIN_HEIGHT, minExtent * 40)
    record({
      rule: 'absurd-height',
      severity: 'warn',
      entityKind: 'building',
      entityId: id,
      message: `impossible sliver (${h.toFixed(1)} m on a ${minExtent.toFixed(1)} m footprint) → clamped to ${clamped.toFixed(1)} m`,
      action: 'clamped',
    })
    return clamped
  }
  return h
}

/** Centroid inside a carriageway AND a majority of footprint vertices inside. */
function onCarriageway(fp: Vec2[], centroid: Vec2, drivable: DrivableGrid): boolean {
  if (!drivable.inside(centroid)) return false
  let inside = 0
  for (const p of fp) if (drivable.inside(p)) inside++
  return inside / fp.length > OVERLAP_FRACTION
}

function underBridgeDeck(
  centroid: Vec2,
  heightM: number,
  decks: { road: RoadSegment; deckElev: number }[],
): { road: RoadSegment; deckElev: number } | null {
  for (const d of decks) {
    const soffit = d.deckElev - DECK_THICKNESS
    if (heightM <= soffit) continue // building clears the deck underside
    const half = Math.max(d.road.widthM, 0) / 2
    const pts = d.road.points
    for (let i = 1; i < pts.length; i++) {
      if (pointSegDist(centroid, pts[i - 1], pts[i]) < half) return d
    }
  }
  return null
}

function dedupeBuildings(live: LiveBuilding[], record: (i: SanityIssue) => void): LiveBuilding[] {
  const kept: LiveBuilding[] = []
  const grid = new Map<string, LiveBuilding[]>()
  const cell = (v: Vec2) => `${Math.round(v.x / DEDUPE_CENTROID_TOL)},${Math.round(v.z / DEDUPE_CENTROID_TOL)}`

  for (const l of live) {
    let dup: LiveBuilding | null = null
    // check the 3×3 neighbourhood of centroid cells
    const cx = Math.round(l.centroid.x / DEDUPE_CENTROID_TOL)
    const cz = Math.round(l.centroid.z / DEDUPE_CENTROID_TOL)
    outer: for (let dx = -1; dx <= 1 && !dup; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${cx + dx},${cz + dz}`)
        if (!bucket) continue
        for (const o of bucket) {
          const dCent = Math.hypot(l.centroid.x - o.centroid.x, l.centroid.z - o.centroid.z)
          const dArea = o.area > 0 ? Math.abs(l.area - o.area) / o.area : 1
          if (dCent <= DEDUPE_CENTROID_TOL && dArea <= DEDUPE_AREA_TOL) {
            dup = o
            break outer
          }
        }
      }
    }
    if (dup) {
      record({
        rule: 'duplicate-building',
        severity: 'warn',
        entityKind: 'building',
        entityId: l.b.id,
        message: `building duplicates ${dup.b.id} (coincident centroid + area)`,
        action: 'dropped',
      })
      continue
    }
    kept.push(l)
    const key = cell(l.centroid)
    let bucket = grid.get(key)
    if (!bucket) grid.set(key, (bucket = []))
    bucket.push(l)
  }
  return kept
}

/** Priority tuple for keep/drop in an overlap: named > taller > bigger > id. */
function priorityRank(l: LiveBuilding): [number, number, number, string] {
  return [l.b.name ? 1 : 0, l.b.heightM, l.area, l.b.id]
}

/** True when `a` should be kept over `b` (a wins). Deterministic total order. */
function aWins(a: LiveBuilding, b: LiveBuilding): boolean {
  const ra = priorityRank(a)
  const rb = priorityRank(b)
  for (let i = 0; i < 3; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i]
  }
  return ra[3] < rb[3] // lower id wins the final tie (stable & deterministic)
}

function resolveOverlaps(live: LiveBuilding[], record: (i: SanityIssue) => void): LiveBuilding[] {
  const dropped = new Set<string>()
  const grid = new Map<string, LiveBuilding[]>()
  const CELL = 24
  const cellsFor = (bb: Bbox): string[] => {
    const keys: string[] = []
    for (let cx = Math.floor(bb.minX / CELL); cx <= Math.floor(bb.maxX / CELL); cx++)
      for (let cz = Math.floor(bb.minZ / CELL); cz <= Math.floor(bb.maxZ / CELL); cz++)
        keys.push(`${cx},${cz}`)
    return keys
  }

  for (const l of live) {
    if (dropped.has(l.b.id)) continue
    const keys = cellsFor(l.bbox)
    const candidates = new Set<LiveBuilding>()
    for (const k of keys) for (const o of grid.get(k) ?? []) candidates.add(o)

    for (const o of candidates) {
      if (o === l || dropped.has(o.b.id) || dropped.has(l.b.id)) continue
      if (!bboxOverlap(l.bbox, o.bbox)) continue
      if (!significantOverlap(l, o)) continue
      const loser = aWins(l, o) ? o : l
      const winner = loser === o ? l : o
      dropped.add(loser.b.id)
      record({
        rule: 'building-overlaps-building',
        severity: 'warn',
        entityKind: 'building',
        entityId: loser.b.id,
        message: `footprint overlaps ${winner.b.id} (>${Math.round(OVERLAP_FRACTION * 100)}% of the smaller) → lower-priority dropped`,
        action: 'dropped',
      })
      if (loser === l) break // this one is gone; stop comparing it
    }
    if (!dropped.has(l.b.id)) {
      for (const k of keys) {
        let bucket = grid.get(k)
        if (!bucket) grid.set(k, (bucket = []))
        bucket.push(l)
      }
    }
  }
  return live.filter((l) => !dropped.has(l.b.id))
}

/** >OVERLAP_FRACTION of the SMALLER footprint's sample points lie in the larger. */
function significantOverlap(a: LiveBuilding, b: LiveBuilding): boolean {
  const [small, big] = a.area <= b.area ? [a, b] : [b, a]
  const samples = [...small.b.footprint, small.centroid]
  let inside = 0
  for (const p of samples) if (pointInRing(p, big.b.footprint)) inside++
  return inside / samples.length > OVERLAP_FRACTION
}

// ---------------------------------------------------------------------------
// ROAD ↔ SURVIVING BUILDING (rule 12: flag only, roads win)
// ---------------------------------------------------------------------------

function flagRoadsThroughBuildings(
  roads: RoadSegment[],
  buildings: BuildingFeature[],
  record: (i: SanityIssue) => void,
): void {
  if (!buildings.length) return
  // index buildings by bbox cells; test drivable, at-grade road samples against
  // the footprints they might cross.
  const CELL = 24
  const grid = new Map<string, LiveBuilding[]>()
  for (const b of buildings) {
    const fp = b.footprint
    const bbox = bboxOf(fp)
    const l: LiveBuilding = { b, centroid: centroidOf(fp), bbox, area: ringAreaM2(fp) }
    for (let cx = Math.floor(bbox.minX / CELL); cx <= Math.floor(bbox.maxX / CELL); cx++)
      for (let cz = Math.floor(bbox.minZ / CELL); cz <= Math.floor(bbox.maxZ / CELL); cz++) {
        const key = `${cx},${cz}`
        let bucket = grid.get(key)
        if (!bucket) grid.set(key, (bucket = []))
        bucket.push(l)
      }
  }

  const flagged = new Set<string>() // one flag per (road,building) pair max
  for (const r of roads) {
    if (NON_DRIVABLE.has(r.roadClass) || r.bridge || r.tunnel) continue
    for (const p of r.points) {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`
      for (const l of grid.get(key) ?? []) {
        const pair = `${r.id}|${l.b.id}`
        if (flagged.has(pair)) continue
        if (pointInRing(p, l.b.footprint)) {
          flagged.add(pair)
          record({
            rule: 'road-through-building',
            severity: 'warn',
            entityKind: 'building',
            entityId: l.b.id,
            message: `drivable road ${r.id} passes through this footprint at grade (roads win — flag only)`,
            action: 'flagged',
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

function deriveBounds(roads: RoadSegment[], buildings: BuildingFeature[]): Bbox {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const acc = (p: Vec2) => {
    if (!isFiniteVec(p)) return
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  for (const r of roads) for (const p of r.points) acc(p)
  if (!Number.isFinite(minX)) for (const b of buildings) for (const p of b.footprint ?? []) acc(p)
  if (!Number.isFinite(minX)) return { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }
  return {
    minX: minX - BOUNDS_MARGIN,
    maxX: maxX + BOUNDS_MARGIN,
    minZ: minZ - BOUNDS_MARGIN,
    maxZ: maxZ + BOUNDS_MARGIN,
  }
}
