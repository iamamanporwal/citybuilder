import type { RegionId } from '../resolver/types'
import type { RoadClass, RoadSegment, Vec2 } from '../types'
import { NON_DRIVABLE } from './roadNetwork'

// Pure (no THREE, no DOM) traffic-device math — orientation, speed units and the
// effective speed limit — shared by the sign renderer (procgen/signs.ts) and the
// semantics exporter so what the learner sees and what the sim enforces agree
// (Road-updates.md §8.5). Deterministic; unit-tested in signMath.test.ts.

export interface NearestRoad {
  /** Unit tangent of the nearest drivable road at the closest point (point order = travel dir). */
  dir: Vec2
  oneway: boolean
  /** Perpendicular distance from the query point to that road's centerline (m). */
  dist: number
  /** The nearest road segment itself (undefined only for hand-built test stubs). */
  road?: RoadSegment
  /** Closest point on that road's centerline. */
  point?: Vec2
  /** Distance along the road polyline to the closest point (m) — the elevation station. */
  station?: number
}

/**
 * Nearest road tangent to a point — used to orient street devices to
 * the road grid instead of a fixed world axis. O(points); fine for the handful
 * of device nodes per scene. Drivable roads only by default; `includePaths`
 * admits footway/cycleway/pedestrian (a lamp mapped on a footbridge must follow
 * the FOOTWAY's elevation, not a distant carriageway's).
 */
export function nearestRoadInfo(pos: Vec2, roads: RoadSegment[], includePaths = false): NearestRoad | null {
  let best = Infinity
  let bestDir: Vec2 | null = null
  let bestRoad: RoadSegment | null = null
  let bestPoint: Vec2 | null = null
  let bestStation = 0
  for (const r of roads) {
    if (!includePaths && NON_DRIVABLE.has(r.roadClass)) continue
    const pts = r.points
    let cum = 0
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x
      const az = pts[i - 1].z
      const dx = pts[i].x - ax
      const dz = pts[i].z - az
      const len2 = dx * dx + dz * dz
      if (len2 < 1e-9) continue
      const l = Math.sqrt(len2)
      let t = ((pos.x - ax) * dx + (pos.z - az) * dz) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = ax + dx * t
      const pz = az + dz * t
      const d2 = (pos.x - px) * (pos.x - px) + (pos.z - pz) * (pos.z - pz)
      if (d2 < best) {
        best = d2
        bestDir = { x: dx / l, z: dz / l }
        bestRoad = r
        bestPoint = { x: px, z: pz }
        bestStation = cum + l * t
      }
      cum += l
    }
  }
  if (!bestDir || !bestRoad) return null
  return {
    dir: bestDir,
    oneway: bestRoad.oneway,
    dist: Math.sqrt(best),
    road: bestRoad,
    point: bestPoint!,
    station: bestStation,
  }
}

/**
 * Curbside position for a traffic device (§8.1). OSM maps signals/stop/give-way
 * nodes ON the highway way itself — rendering a physical pole at the raw node
 * position plants it in the middle of the carriageway (and the drive preview
 * crashes into it). A device within the roadway moves perpendicular to the
 * driving side, just past the curb; a node already clear of the carriageway is
 * authoritative and stays put.
 */
export function curbsideDevicePosition(
  pos: Vec2,
  near: NearestRoad | null,
  drivingSide: 'left' | 'right',
): Vec2 {
  if (!near || !near.road || !near.point) return pos
  const half = near.road.widthM / 2
  if (near.dist > half + 0.2) return pos
  const s = drivingSide === 'right' ? -1 : 1 // matches the speed-sign side convention
  const across = { x: -near.dir.z * s, z: near.dir.x * s }
  const off = half + 0.7
  return { x: near.point.x + across.x * off, z: near.point.z + across.z * off }
}

/**
 * Y-rotation (radians) so a device whose front faces local +Z points along the
 * road. `faceOncoming` = true rotates 180° so a sign confronts approaching
 * traffic (the driver reads it); false aligns it with travel (signal heads).
 * Returns 0 when there is no nearby road (falls back to world axis).
 */
export function deviceHeading(near: NearestRoad | null, faceOncoming: boolean): number {
  if (!near) return 0
  const s = faceOncoming ? -1 : 1
  return Math.atan2(near.dir.x * s, near.dir.z * s)
}

/** Region speed unit. US/UK sign faces are mph; everywhere else km/h. */
export function speedUnitFor(region: RegionId): 'mph' | 'km/h' {
  return region === 'us' || region === 'uk' ? 'mph' : 'km/h'
}

/** Convert a stored km/h limit to the region's display unit, rounded to a real posted increment. */
export function displaySpeed(kmh: number, unit: 'mph' | 'km/h'): number {
  if (unit === 'mph') return Math.max(5, Math.round(kmh / 1.60934 / 5) * 5)
  return Math.max(5, Math.round(kmh / 5) * 5)
}

// Region-agnostic urban defaults by class (km/h). Applied where OSM has no
// maxspeed; the result is flagged 'default' (low-confidence) so a human verifies
// before the city is used for training (fidelity policy §1).
const DEFAULT_SPEED_KMH: Record<RoadClass, number> = {
  motorway: 100,
  trunk: 90,
  primary: 60,
  secondary: 50,
  tertiary: 50,
  unclassified: 40,
  residential: 30,
  living_street: 20,
  service: 20,
  pedestrian: 10,
  footway: 0,
  cycleway: 20,
}

export interface EffectiveSpeed {
  kmh: number
  source: 'tag' | 'default'
}

/**
 * The speed limit for a road: the OSM tag when present (faithful), else a region
 * default flagged low-confidence. Null for non-drivable classes. Region is
 * reserved for future region-specific defaults; the signature stays stable.
 */
export function effectiveSpeed(road: RoadSegment, _region?: RegionId): EffectiveSpeed | null {
  if (NON_DRIVABLE.has(road.roadClass)) return null
  if (road.maxspeedKmh != null && isFinite(road.maxspeedKmh)) {
    return { kmh: road.maxspeedKmh, source: 'tag' }
  }
  return { kmh: DEFAULT_SPEED_KMH[road.roadClass] ?? 40, source: 'default' }
}
