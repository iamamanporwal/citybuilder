import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ingestOverpass } from '../ingest/overpass'
import { resolveRoad } from '../resolver/resolve'
import type { ResolvedContext, RoadResolution } from '../resolver/types'
import { buildColliders } from '../physics/colliders'
import { colliderLint } from '../physics/colliderLint'
import { buildRoadSemantics } from '../export/semantics'
import { BRIDGE_LAYER_H } from '../procgen/roadNetwork'
import { ringAreaM2, ringIsSimple } from '../procgen/geometry'

// Collider generation over the bundled Lower Manhattan fixture: coverage,
// elevation flow-through, NaN safety, lint gating, 3D semantics centerlines.

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/data/raw_osm.json', import.meta.url)), 'utf8'),
)
const graph = ingestOverpass(raw, 'Lower Manhattan')

// resolveContext is async/fetchy — construct the context literal directly
const ctx: ResolvedContext = {
  matrixVersion: 'test',
  region: {
    id: 'us',
    label: 'United States',
    drivingSide: 'right',
    centerline: 'double-yellow',
    crosswalk: 'continental',
    signShape: 'us-rect',
    lampStyle: 'cobra',
  },
  climate: 'temperate',
  treePool: [],
  treePoolSource: 'climate-default',
  landCoverSource: 'none',
  landCoverAt: () => 'built',
  zoneAt: () => 'none',
  provenance: [],
}

const resolutions = new Map<string, RoadResolution>()
for (const r of graph.roads) resolutions.set(r.id, resolveRoad(r, ctx))

const set = buildColliders(graph, resolutions)

describe('collider generation (Lower Manhattan fixture)', () => {
  it('covers every non-tunnel road', () => {
    const roadIds = new Set(
      set.colliders.filter((c) => c.semantics.class === 'road').map((c) => c.semantics.featureId),
    )
    for (const r of graph.roads) {
      if (r.tunnel || r.points.length < 2) continue
      expect(roadIds.has(r.id), `road ${r.id} missing collider`).toBe(true)
    }
  })

  it('covers every valid building footprint', () => {
    const buildingIds = new Set(
      set.colliders.filter((c) => c.semantics.class === 'building').map((c) => c.semantics.featureId),
    )
    const valid = graph.buildings.filter(
      (b) => b.footprint.length >= 3 && ringIsSimple(b.footprint) && ringAreaM2(b.footprint) >= 1,
    )
    expect(valid.length).toBeGreaterThan(100)
    for (const b of valid) expect(buildingIds.has(b.id), `building ${b.id} missing collider`).toBe(true)
  })

  it('emits exactly one terrain box and water sensors', () => {
    expect(set.stats.terrain).toBe(1)
    const water = set.colliders.filter((c) => c.semantics.class === 'water')
    expect(water.length).toBeGreaterThanOrEqual(1)
    for (const w of water) expect(w.semantics.sensor).toBe(true)
  })

  it('bridge road colliders carry real elevation', () => {
    const bridges = set.colliders.filter((c) => c.semantics.class === 'road' && c.semantics.bridge)
    expect(bridges.length).toBeGreaterThanOrEqual(1)
    let elevated = 0
    for (const b of bridges) {
      const pos = b.geometry!.getAttribute('position')
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > 1) {
          elevated++
          break
        }
      }
    }
    expect(elevated).toBeGreaterThanOrEqual(1)
  })

  it('bridge decks get rail barriers so cars cannot drive off', () => {
    const rails = set.colliders.filter((c) => c.semantics.class === 'barrier' && c.semantics.bridge)
    expect(rails.length).toBeGreaterThan(0)
  })

  it('contains no non-finite values anywhere', () => {
    for (const c of set.colliders) {
      for (const v of [...c.transform.position, ...c.transform.quaternion]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      if (c.geometry) {
        const arr = c.geometry.getAttribute('position').array as Float32Array
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) throw new Error(`NaN in ${c.id}`)
        }
      }
    }
  })

  it('passes colliderLint with no warnings', () => {
    const warnings = colliderLint(graph, set)
    expect(warnings.filter((w) => w.severity === 'warn')).toEqual([])
  })

  it('lint flags a missing road collider', () => {
    const broken = {
      ...set,
      colliders: set.colliders.filter(
        (c, i) => !(c.semantics.class === 'road' && i === set.colliders.findIndex((x) => x.semantics.class === 'road')),
      ),
    }
    const warnings = colliderLint(graph, broken)
    expect(warnings.some((w) => w.severity === 'warn' && w.message.includes('road'))).toBe(true)
  })

  it('lint flags injected NaN', () => {
    const victim = set.colliders.find((c) => c.kind === 'box')!
    const broken = {
      ...set,
      colliders: set.colliders.map((c) =>
        c === victim ? { ...c, transform: { ...c.transform, position: [NaN, 0, 0] as [number, number, number] } } : c,
      ),
    }
    const warnings = colliderLint(graph, broken)
    expect(warnings.some((w) => w.severity === 'warn' && w.message.includes('non-finite'))).toBe(true)
  })
})

describe('semantics v2 road entries', () => {
  const entries = buildRoadSemantics(graph.roads, resolutions)

  it('emits 3-component centerlines for every road', () => {
    expect(entries.length).toBe(graph.roads.length)
    for (const e of entries) {
      for (const p of e.centerline) {
        expect(p.length).toBe(3)
        for (const v of p) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('bridge roads peak at layer height; at-grade roads stay at zero', () => {
    for (const e of entries) {
      const maxY = Math.max(...e.centerline.map((p) => p[1]))
      if (e.bridge) {
        expect(e.elevation).not.toBeNull()
        expect(e.elevation!.bridge_height_m).toBeGreaterThanOrEqual(BRIDGE_LAYER_H - 0.01)
        expect(maxY).toBeLessThanOrEqual(e.elevation!.bridge_height_m + 0.01)
      } else if (!e.tunnel) {
        expect(maxY).toBe(0)
      }
    }
  })

  it('carries cross-section and drivability', () => {
    const withSidewalks = entries.filter((e) => e.cross_section?.sidewalks)
    expect(withSidewalks.length).toBeGreaterThan(0)
    const footways = entries.filter((e) => e.class === 'footway')
    for (const f of footways) expect(f.drivable).toBe(false)
  })
})
