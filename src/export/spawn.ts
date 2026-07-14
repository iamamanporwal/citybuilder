import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Vec2 } from '../types'
import { offsetPolyline, ribbonGeometry } from '../procgen/geometry'
import type { RoadSemanticsEntry } from './semantics'

// Auto-derived spawn + minimap (fixes the engine's "had to hand-pick the spawn"
// and "minimap falls back to full surface" flags). Both are computed from the
// road semantics we already export, so a new map needs zero code edits.

export interface SpawnPoint {
  /** World start position on the road surface: [x, y, z] in meters. */
  position: [number, number, number]
  /** Unit forward direction the car should face: [x, 0, z]. */
  forward: [number, number, number]
  /** Yaw around +Y in radians (0 = +X, CCW), matching the app's yaw convention. */
  heading_rad: number
  road_id: string
  road_class: string
  width_m: number
  note: string
}

interface Bounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const CLASS_RANK: Record<string, number> = {
  primary: 5,
  secondary: 4,
  tertiary: 3,
  residential: 2,
  service: 1,
}

function polylineLengthXZ(pts: [number, number, number][]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2])
  }
  return len
}

/**
 * Pick a spawn on a wide, drivable, flat (non-bridge/tunnel) road near the map
 * centre with enough straight run ahead, and face down its centerline.
 */
export function deriveSpawn(roads: RoadSemanticsEntry[], bounds: Bounds): SpawnPoint | null {
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) || 1

  let best: { entry: RoadSemanticsEntry; i: number; score: number } | null = null
  for (const r of roads) {
    if (!r.drivable || r.bridge || r.tunnel) continue
    if (r.centerline.length < 2) continue
    const length = polylineLengthXZ(r.centerline)
    if (length < 20) continue // need room to accelerate
    // evaluate the vertex nearest the map centre that still has a point ahead
    for (let i = 0; i + 1 < r.centerline.length; i++) {
      const p = r.centerline[i]
      const dist = Math.hypot(p[0] - cx, p[2] - cz)
      const centreScore = 1 - Math.min(1, dist / span) // 1 at centre → 0 at edge
      const classScore = (CLASS_RANK[r.class] ?? 1) / 5
      const widthScore = Math.min(1, r.width_m / 12)
      const lengthScore = Math.min(1, length / 120)
      const score = centreScore * 0.4 + classScore * 0.25 + widthScore * 0.2 + lengthScore * 0.15
      if (!best || score > best.score) best = { entry: r, i, score }
    }
  }
  if (!best) return null

  const { entry, i } = best
  const a = entry.centerline[i]
  const b = entry.centerline[i + 1]
  let dx = b[0] - a[0]
  let dz = b[2] - a[2]
  const mag = Math.hypot(dx, dz) || 1
  dx /= mag
  dz /= mag
  return {
    position: [a[0], a[1], a[2]],
    forward: [dx, 0, dz],
    heading_rad: Math.atan2(-dz, dx),
    road_id: entry.id,
    road_class: entry.class,
    width_m: entry.width_m,
    note: 'Auto-selected: widest drivable non-bridge road nearest the map centre.',
  }
}

const MINIMAP_COLORS: Record<string, string> = {
  primary: '#e8b04a',
  secondary: '#d8d2c4',
  tertiary: '#cfcabd',
  residential: '#b8b3a6',
  service: '#9a958a',
}

/**
 * Roads-only flat mesh for the top-down minimap. Thin ribbons at y=0, colored by
 * class, one merged-free Group the game can render orthographically. Kept
 * deliberately tiny (no buildings, no elevation, unlit schematic material).
 */
export function buildMinimapGroup(roads: RoadSemanticsEntry[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'citybuilder_minimap'
  // one merged mesh per class color → a handful of draw calls, not one per road
  const byColor = new Map<string, THREE.BufferGeometry[]>()

  for (const r of roads) {
    if (!r.drivable || r.centerline.length < 2) continue
    const pts: Vec2[] = r.centerline.map((p) => ({ x: p[0], z: p[2] }))
    const half = Math.max(1, r.width_m / 2)
    const geo = ribbonGeometry(offsetPolyline(pts, half), offsetPolyline(pts, -half), pts.map(() => 0))
    geo.deleteAttribute('normal')
    geo.deleteAttribute('uv')
    if (!geo.getIndex()) {
      const count = geo.getAttribute('position').count
      const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
      for (let i = 0; i < count; i++) arr[i] = i
      geo.setIndex(new THREE.BufferAttribute(arr, 1))
    }
    const color = MINIMAP_COLORS[r.class] ?? '#b0aba0'
    if (!byColor.has(color)) byColor.set(color, [])
    byColor.get(color)!.push(geo)
  }

  for (const [color, geos] of byColor) {
    let merged: THREE.BufferGeometry | null = null
    try {
      merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    } catch {
      merged = null
    }
    const mat = new THREE.MeshBasicMaterial({ color })
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = `mm_${color.replace('#', '')}`
      group.add(mesh)
    } else {
      geos.forEach((g) => group.add(new THREE.Mesh(g, mat)))
    }
  }
  return group
}
