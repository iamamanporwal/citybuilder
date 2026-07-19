import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { CityGraph, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { planarUvXZ, raisedRibbonGeometry } from '../procgen/geometry'

// Regression suite for the second z-fighting root cause (the first was depth
// precision — see flickerInvariants.test.ts): EXACTLY coplanar overlaps, which
// no depth buffer can resolve. Junction discs and sidewalk tops legitimately
// overlap at one layer height, so their overdraw must be idempotent: identical
// material + world-planar UVs ⇒ any depth-tie winner paints the same pixel.
// Manholes are the remaining stamped decals and must be rejection-sampled.

vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return {
    roadMaterial: mat,
    sidewalkMaterial: mat(),
    facadeMaterial: mat,
    roofMaterial: mat,
    decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() },
  }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => mat() }) }
})

function road(id: string, points: Vec2[], over: Partial<RoadSegment> = {}): RoadSegment {
  return {
    id,
    roadClass: 'primary',
    points,
    widthM: 14,
    lanes: 4,
    oneway: false,
    bridge: false,
    tunnel: false,
    layer: 0,
    centerLat: 0,
    centerLng: 0,
    ...over,
  }
}

const resolution: RoadResolution = {
  surface: 'asphalt-worn',
  marking: { centerColor: 'white', centerPattern: 'dashed', crosswalk: 'zebra' },
  crossSection: { sidewalks: true, sidewalkWidth: 2.4, curbHeight: 0.22 },
  decalDensity: 0.5,
  provenance: [],
  confidence: 1,
} as RoadResolution

/**
 * Dense grid of wide crossing roads, split at every crossing (like OSM ways),
 * so every grid point is a real junction. Junction detection counts segment
 * ENDPOINTS only (analyzeRoadNodes).
 */
function gridGraph(n: number, spacing: number): { graph: CityGraph; resolutions: Map<string, RoadResolution> } {
  const roads: RoadSegment[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - 1; j++) {
      roads.push(road(`h${i}_${j}`, [{ x: j * spacing, z: i * spacing }, { x: (j + 1) * spacing, z: i * spacing }]))
      roads.push(road(`v${i}_${j}`, [{ x: i * spacing, z: j * spacing }, { x: i * spacing, z: (j + 1) * spacing }]))
    }
  }
  const resolutions = new Map(roads.map((r) => [r.id, resolution]))
  return { graph: { roads, buildings: [], areas: [], pois: [] } as unknown as CityGraph, resolutions }
}

/**
 * Assert world-planar UVs. With onlyAtY set, checks only upward-facing (top
 * face) vertices at that height — skirt walls top out at the same Y but face
 * sideways and legitimately keep wall UVs.
 */
function uvIsWorldPlanar(g: THREE.BufferGeometry, onlyAtY?: number): void {
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const uv = g.getAttribute('uv')
  expect(uv, 'geometry must have uvs').toBeTruthy()
  let checked = 0
  for (let i = 0; i < pos.count; i++) {
    if (onlyAtY !== undefined && (Math.abs(pos.getY(i) - onlyAtY) > 1e-6 || nrm.getY(i) < 0.9)) continue
    expect(uv.getX(i)).toBeCloseTo(pos.getX(i), 4)
    expect(uv.getY(i)).toBeCloseTo(-pos.getZ(i), 4)
    checked++
  }
  expect(checked).toBeGreaterThan(0)
}

describe('idempotent overdraw for same-layer surfaces', () => {
  it('planarUvXZ writes uv = (x, -z)', () => {
    const g = new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2).translate(3, 0.11, -7)
    uvIsWorldPlanar(planarUvXZ(g))
  })

  it('junction discs carry world-planar UVs (overlapping discs render identically)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const { graph, resolutions } = gridGraph(5, 30)
    const result = buildRoads(graph, {} as ResolvedContext, resolutions)
    expect(result.intersections).toBeTruthy()
    uvIsWorldPlanar(result.intersections!.geometry)
  })

  it('sidewalk top faces carry world-planar UVs (corner overlaps render identically)', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const { graph, resolutions } = gridGraph(5, 60)
    const result = buildRoads(graph, {} as ResolvedContext, resolutions)
    expect(result.sidewalks).toBeTruthy()
    uvIsWorldPlanar(result.sidewalks!.geometry, resolution.crossSection.curbHeight)
  })

  it('raisedRibbonGeometry top face is world-planar, skirts keep wall UVs', () => {
    const left = [{ x: 0, z: 0 }, { x: 10, z: 0 }]
    const right = [{ x: 0, z: 3 }, { x: 10, z: 3 }]
    uvIsWorldPlanar(raisedRibbonGeometry(left, right, 0.22), 0.22)
  })

  it('a junction fully contained in a larger one adds no extra coplanar pad', async () => {
    const { buildRoads } = await import('../procgen/roads')
    // wide 4-arm junction at origin + a narrow 4-arm junction 1 m away, fully
    // contained in the big one (arms meet at endpoints, like OSM ways split at
    // intersections). The contained junction must contribute NO separate coplanar
    // surface — whether it renders through the single-node containment drop or the
    // cluster arm-hull, the merged intersection geometry is identical to the big
    // junction alone (robust to the flare/curb-return pad shape, which is what
    // makes overlapping same-layer pads safe: idempotent world-planar overdraw).
    const big = [
      road('w_e', [{ x: 0, z: 0 }, { x: 60, z: 0 }], { widthM: 20 }),
      road('w_w', [{ x: 0, z: 0 }, { x: -60, z: 0 }], { widthM: 20 }),
      road('w_n', [{ x: 0, z: 0 }, { x: 0, z: 60 }], { widthM: 20 }),
      road('w_s', [{ x: 0, z: 0 }, { x: 0, z: -60 }], { widthM: 20 }),
    ]
    const small = [
      road('n_e', [{ x: 1, z: 1 }, { x: 61, z: 1 }], { widthM: 4 }),
      road('n_w', [{ x: 1, z: 1 }, { x: -59, z: 1 }], { widthM: 4 }),
      road('n_n', [{ x: 1, z: 1 }, { x: 1, z: 61 }], { widthM: 4 }),
      road('n_s', [{ x: 1, z: 1 }, { x: 1, z: -59 }], { widthM: 4 }),
    ]
    const build = (roads: RoadSegment[]) =>
      buildRoads(
        { roads, buildings: [], areas: [], pois: [] } as unknown as CityGraph,
        {} as ResolvedContext,
        new Map(roads.map((r) => [r.id, resolution])),
      )
    const bigOnly = build(big)
    const withSmall = build([...big, ...small])
    const attr = (r: typeof bigOnly) =>
      r.intersections!.geometry.getAttribute('position') as THREE.BufferAttribute
    // The contained junction must not add a SEPARATE coplanar pad: it merges into
    // the big junction's one patch (proximity cluster). The merged union pad may
    // trim its arms back to the merged disc boundary, so it is not byte-identical
    // to the big-junction-alone pad — but it stays a single, comparably-sized patch
    // (not ~doubled, which is what a stray second pad would look like) and keeps the
    // same footprint (not a wider oval blob — the whole point of the union outline).
    expect(withSmall.intersections).not.toBeNull()
    expect(attr(withSmall).count).toBeLessThan(attr(bigOnly).count * 1.6) // no doubled pad
    const boxA = new THREE.Box3().setFromBufferAttribute(attr(bigOnly))
    const boxB = new THREE.Box3().setFromBufferAttribute(attr(withSmall))
    expect(boxB.max.x).toBeCloseTo(boxA.max.x, 0) // same footprint, not a wider blob
    expect(boxB.min.x).toBeCloseTo(boxA.min.x, 0)
    expect(boxB.max.z).toBeCloseTo(boxA.max.z, 0)
  })

  it('paths render one layer below carriageways with world-planar UVs', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const roads = [
      road('ave', [{ x: -50, z: 0 }, { x: 50, z: 0 }]),
      // footway crossing the avenue at grade — no shared node, no trimming
      road('walk', [{ x: 0, z: -50 }, { x: 0, z: 50 }], { roadClass: 'footway', widthM: 3, lanes: 0 }),
    ]
    const resolutions = new Map(roads.map((r) => [r.id, resolution]))
    const graph = { roads, buildings: [], areas: [], pois: [] } as unknown as CityGraph
    const result = buildRoads(graph, {} as ResolvedContext, resolutions)
    const ave = result.roadMeshes.get('ave')!
    const walk = result.roadMeshes.get('walk')!
    const yOf = (m: THREE.Mesh) => (m.geometry.getAttribute('position') as THREE.BufferAttribute).getY(0)
    expect(yOf(ave)).toBeCloseTo(0.05, 6)
    expect(yOf(walk)).toBeCloseTo(0.046, 6)
    expect(yOf(walk)).toBeLessThan(yOf(ave)) // carriageway wins where they cross
    uvIsWorldPlanar(walk.geometry)
  })

  it('offsetPolyline collapses fold-overs instead of self-overlapping', async () => {
    const { offsetPolyline } = await import('../procgen/geometry')
    // hairpin with ~2 m curvature radius, offset 6 m — folds without the fix
    const pts: Vec2[] = []
    for (let a = 0; a <= Math.PI; a += Math.PI / 16) pts.push({ x: Math.cos(a) * 2, z: Math.sin(a) * 2 })
    const off = offsetPolyline(pts, 6)
    for (let i = 1; i < pts.length; i++) {
      const rx = pts[i].x - pts[i - 1].x, rz = pts[i].z - pts[i - 1].z
      const ox = off[i].x - off[i - 1].x, oz = off[i].z - off[i - 1].z
      expect(rx * ox + rz * oz, `offset segment ${i} reverses against the reference line`).toBeGreaterThanOrEqual(0)
    }
  })

  it('flat ribbons get exact up normals (folds cannot shade dark)', async () => {
    const { ribbonGeometry, offsetPolyline } = await import('../procgen/geometry')
    const pts: Vec2[] = []
    for (let a = 0; a <= Math.PI; a += Math.PI / 16) pts.push({ x: Math.cos(a) * 3, z: Math.sin(a) * 3 })
    const g = ribbonGeometry(offsetPolyline(pts, 2), offsetPolyline(pts, -2), 0.05)
    const nrm = g.getAttribute('normal')
    for (let i = 0; i < nrm.count; i++) {
      expect(nrm.getX(i)).toBe(0)
      expect(nrm.getY(i)).toBe(1)
      expect(nrm.getZ(i)).toBe(0)
    }
  })

  it('manholes are rejection-sampled: no same-Y overlapping decal quads anywhere', async () => {
    const { buildRoads } = await import('../procgen/roads')
    // junctions 8 m apart with 14 m roads: unguarded manholes would overlap
    const { graph, resolutions } = gridGraph(6, 8)
    const result = buildRoads(graph, {} as ResolvedContext, resolutions)
    expect(result.decals).toBeTruthy()
    interface Quad { minX: number; maxX: number; minZ: number; maxZ: number; y: number }
    const quads: Quad[] = []
    result.decals!.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const pos = mesh.geometry.getAttribute('position')
      for (let q = 0; q + 3 < pos.count; q += 4) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
        for (let v = q; v < q + 4; v++) {
          minX = Math.min(minX, pos.getX(v)); maxX = Math.max(maxX, pos.getX(v))
          minZ = Math.min(minZ, pos.getZ(v)); maxZ = Math.max(maxZ, pos.getZ(v))
        }
        quads.push({ minX, maxX, minZ, maxZ, y: pos.getY(q) })
      }
    })
    expect(quads.length).toBeGreaterThan(2) // manholes actually spawned
    for (let i = 0; i < quads.length; i++) {
      for (let j = i + 1; j < quads.length; j++) {
        const a = quads[i], b = quads[j]
        if (Math.abs(a.y - b.y) > 0.001) continue
        const overlap = !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ)
        expect(overlap, `decal quads ${i} and ${j} overlap at y=${a.y}`).toBe(false)
      }
    }
  })
})
