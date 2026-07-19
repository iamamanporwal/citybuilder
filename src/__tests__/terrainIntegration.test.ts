import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ingestOverpass } from '../ingest/overpass'
import { resolveRoad } from '../resolver/resolve'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { buildColliders } from '../physics/colliders'
import { solveNetworkElevation } from '../procgen/corridor/elevation'
import { cumulative } from '../procgen/roadNetwork'
import { buildTerrainField, setActiveTerrain } from '../procgen/terrain/field'
import { terrainGridGeometry } from '../procgen/terrain/mesh'
import { withTerrain } from '../procgen/terrain/config'
import { waterRings } from '../procgen/areas'

// End-to-end wiring of the terrain field: the road-elevation solve follows the
// land and stays stable, the ground mesh gets relief, and the physics terrain
// collider becomes the displaced surface — while flag-off stays the flat world.

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/data/prague_osm.json', import.meta.url)), 'utf8'),
)
const graph = ingestOverpass(raw, 'Staré Město, Prague')

function sceneBounds() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const r of graph.roads) for (const p of r.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  return { minX: minX - 120, maxX: maxX + 120, minZ: minZ - 120, maxZ: maxZ + 120 }
}
const bounds = sceneBounds()
const water = graph.areas.filter((a) => a.kind === 'water')
const { carved, painted } = waterRings(water, bounds)
const field = withTerrain(true, () => buildTerrainField(bounds, [...carved, ...painted]))

const ctx: ResolvedContext = {
  matrixVersion: 'test',
  region: { id: 'eu-central', label: 'Czechia', drivingSide: 'right', centerline: 'white-solid', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'euro-post' },
  climate: 'temperate', treePool: [], treePoolSource: 'climate-default', landCoverSource: 'none',
  landCoverAt: () => 'built', zoneAt: () => 'none', provenance: [],
}
const resolutions = new Map<string, RoadResolution>()
for (const r of graph.roads) resolutions.set(r.id, resolveRoad(r, ctx))

describe('terrain integration (Prague sample)', () => {
  it('makes the road-elevation solve follow the terrain and stay stable', () => {
    setActiveTerrain(null)
    const flat = solveNetworkElevation(graph.roads)
    setActiveTerrain(field)
    const relief = solveNetworkElevation(graph.roads)
    setActiveTerrain(null)

    // the solve still converges with terrain feeding the base height
    expect(relief.stats.converged).toBe(true)

    // roads visibly move off the flat datum onto the land
    let maxDiff = 0
    for (const r of graph.roads) {
      if (r.points.length < 2) continue
      const cum = cumulative(r.points)
      const a = flat.profileFor(r, cum)
      const b = relief.profileFor(r, cum)
      for (let i = 0; i < cum.length; i++) maxDiff = Math.max(maxDiff, Math.abs(b[i] - a[i]))
    }
    expect(maxDiff).toBeGreaterThan(0.3)
  })

  it('gives the ground mesh real relief with terrain on, and none with it off', () => {
    const yRange = (geo: { getAttribute: (n: string) => { count: number; getY: (i: number) => number } }) => {
      const pos = geo.getAttribute('position')
      let min = Infinity, max = -Infinity
      for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); min = Math.min(min, y); max = Math.max(max, y) }
      return max - min
    }
    setActiveTerrain(field)
    const relief = terrainGridGeometry(bounds)
    setActiveTerrain(null)
    const flat = terrainGridGeometry(bounds)
    expect(yRange(relief)).toBeGreaterThan(1) // rolling ground + river valley
    expect(yRange(flat)).toBe(0) // dead flat when the field is inert
  })

  it('emits a displaced trimesh terrain collider when on, a flat box when off', () => {
    const flatSet = buildColliders(graph, resolutions) // terrain flag off (default)
    const flatTerrain = flatSet.colliders.find((c) => c.semantics.featureId === 'terrain_ground')!
    expect(flatTerrain.kind).toBe('box')

    let reliefKind = ''
    let reliefCount = 0
    withTerrain(true, () => {
      setActiveTerrain(field)
      const s = buildColliders(graph, resolutions)
      reliefKind = s.colliders.find((c) => c.semantics.featureId === 'terrain_ground')!.kind
      reliefCount = s.stats.terrain
    })
    setActiveTerrain(null)
    expect(reliefKind).toBe('trimesh')
    expect(reliefCount).toBe(1)
  })
})
