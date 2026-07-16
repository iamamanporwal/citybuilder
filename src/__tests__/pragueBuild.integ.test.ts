import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ResolvedContext } from '../resolver/types'
import { REGION_PACKS, MATRIX_VERSION } from '../resolver/matrix'
import { CLIMATE_TREES } from '../resolver/matrix'
import { ingestOverpass } from '../ingest/overpass'
import { resolveRoad } from '../resolver/resolve'

vi.mock('../materials/library', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { roadMaterial: mat, sidewalkMaterial: mat(), facadeMaterial: mat, roofMaterial: mat, decalMaterials: { crack: mat(), stain: mat(), patch: mat(), manhole: mat() } }
})
vi.mock('../procgen/materials', () => {
  const mat = () => new THREE.MeshBasicMaterial()
  return { mats: new Proxy({}, { get: () => mat() }) }
})

const praguePath = fileURLToPath(new URL('../../public/data/prague_osm.json', import.meta.url))

function euCentralCtx(): ResolvedContext {
  return {
    matrixVersion: MATRIX_VERSION,
    region: REGION_PACKS['eu-central'],
    climate: 'continental',
    treePool: CLIMATE_TREES.continental,
    treePoolSource: 'climate-default',
    landCoverSource: 'osm-derived',
    landCoverAt: () => 'built',
    zoneAt: () => 'none',
    provenance: [],
  }
}

describe('Prague Staré Město sample (real OSM)', () => {
  const raw = JSON.parse(readFileSync(praguePath, 'utf8'))
  const graph = ingestOverpass(raw, 'Staré Město, Prague')

  it('ingests a rich old-town graph with the Vltava and its bridges', () => {
    expect(graph.buildings.length).toBeGreaterThan(1000)
    expect(graph.roads.length).toBeGreaterThan(1000)
    expect(graph.areas.some((a) => a.kind === 'water')).toBe(true)
    const bridges = graph.roads.filter((r) => r.bridge)
    expect(bridges.length).toBeGreaterThan(5)
  })

  it('recognises Charles Bridge (Karlův most, Q204871) and builds it as a stone-arch landmark', async () => {
    const { buildRoads } = await import('../procgen/roads')
    const ctx = euCentralCtx()
    const resolutions = new Map(graph.roads.map((r) => [r.id, resolveRoad(r, ctx)]))
    const result = buildRoads(graph, ctx, resolutions)

    const charles = result.landmarkBridges.find((b) => b.id === 'landmark_charles-bridge')
    expect(charles, 'Charles Bridge landmark bridge should be built').toBeTruthy()
    expect(charles!.structure).toBe('stone-arch')
    expect(charles!.wikidata).toBe('Q204871')
    // it must actually produce geometry rising above the water into towers
    const box = new THREE.Box3().setFromObject(charles!.group)
    expect(box.max.y).toBeGreaterThan(20)

    // drivable Vltava road bridges keep the generic deck+rails+piers structure
    expect(result.bridges, 'generic bridge structures for the road bridges').toBeTruthy()

    // markings mesh exists (white centre lines / crosswalks / stop lines)
    expect(result.markings).toBeTruthy()
  })

  it('resolves Czechia region markings: white centre lines, right-hand, zebra crosswalks', () => {
    const ctx = euCentralCtx()
    expect(ctx.region.drivingSide).toBe('right')
    expect(ctx.region.centerline).toBe('white-dashed')
    expect(ctx.region.crosswalk).toBe('zebra')
    const drivable = graph.roads.find((r) => r.roadClass === 'secondary' || r.roadClass === 'tertiary')!
    const res = resolveRoad(drivable, ctx)
    expect(res.marking.centerColor).toBe('white')
  })
})
