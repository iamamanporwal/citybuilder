import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { ingestOverpass } from '../ingest/overpass'
import { buildTerrain, WATER_DEPTH } from '../procgen/areas'

// Structural regression test for the flicker fix: water must be CARVED out of
// the terrain (ShapeGeometry holes), leaving no ground face under a water
// surface — ground and water can then never be near-coplanar.

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/data/raw_osm.json', import.meta.url)), 'utf8'),
)
const graph = ingestOverpass(raw, 'Lower Manhattan')

function bounds() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const r of graph.roads) for (const p of r.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  return { minX: minX - 120, maxX: maxX + 120, minZ: minZ - 120, maxZ: maxZ + 120 }
}

function trianglesOf(mesh: THREE.Mesh): { ax: number; az: number; bx: number; bz: number; cx: number; cz: number }[] {
  const pos = mesh.geometry.getAttribute('position')
  const idx = mesh.geometry.getIndex()!
  const out = []
  for (let i = 0; i < idx.count; i += 3) {
    const [a, b, c] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]
    out.push({
      ax: pos.getX(a), az: pos.getZ(a),
      bx: pos.getX(b), bz: pos.getZ(b),
      cx: pos.getX(c), cz: pos.getZ(c),
    })
  }
  return out
}

function pointInTriangle(px: number, pz: number, t: ReturnType<typeof trianglesOf>[number]): boolean {
  const s1 = (t.bx - t.ax) * (pz - t.az) - (t.bz - t.az) * (px - t.ax)
  const s2 = (t.cx - t.bx) * (pz - t.bz) - (t.cz - t.bz) * (px - t.bx)
  const s3 = (t.ax - t.cx) * (pz - t.cz) - (t.az - t.cz) * (px - t.cx)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

describe('terrain carving', () => {
  const terrain = buildTerrain(graph.areas.filter((a) => a.kind === 'water'), bounds())

  it('carves the harbor into the ground as a real hole', () => {
    expect(terrain.carvedCount).toBeGreaterThanOrEqual(1)
    expect(terrain.water).not.toBeNull()
  })

  it('leaves no ground face under carved water (no coplanar pair possible)', () => {
    const groundTris = trianglesOf(terrain.ground)
    const waterSurface = terrain.water!.children[0] as THREE.Mesh
    const waterTris = trianglesOf(waterSurface)
    expect(waterTris.length).toBeGreaterThan(0)
    // probe every carved-water triangle centroid: none may be covered by ground
    let covered = 0
    for (const w of waterTris) {
      const px = (w.ax + w.bx + w.cx) / 3
      const pz = (w.az + w.bz + w.cz) / 3
      if (groundTris.some((t) => pointInTriangle(px, pz, t))) covered++
    }
    expect(covered).toBe(0)
  })

  it('sinks carved water below grade', () => {
    const waterSurface = terrain.water!.children[0] as THREE.Mesh
    const pos = waterSurface.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeCloseTo(-WATER_DEPTH, 5)
    }
  })
})
