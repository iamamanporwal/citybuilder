import { describe, expect, it, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import type { BuildingFeature, Vec2 } from '../types'
import type { ResolvedContext, ZoneKind } from '../resolver/types'
import { REGION_PACKS } from '../resolver/matrix'
import { gatherPriors, normalizeRoofShape } from '../recognizer/priors'
import { describeFromPriors } from '../recognizer/descriptor'
import {
  clearRecognizerCache,
  recognizeBuilding,
  setWikidataStyle,
} from '../recognizer/recognizer'

// The store transitively imports the material library, which builds canvas
// textures at module load — stub it (and procgen/materials) so the flag-default
// assertion runs in plain node, matching roadElevation / coplanarOverdraw.
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

import { buildProceduralBuilding, buildRoofCap } from '../procgen/buildings'
import type { BuildingResolution } from '../resolver/types'
import { useEditor } from '../state/store'

// ---- fixtures ----

function square(size: number): Vec2[] {
  return [
    { x: 0, z: 0 },
    { x: size, z: 0 },
    { x: size, z: size },
    { x: 0, z: size },
  ]
}

function building(over: Partial<BuildingFeature> & { id: string }): BuildingFeature {
  return {
    id: over.id,
    name: over.name,
    footprint: over.footprint ?? square(14),
    heightM: over.heightM ?? 12,
    levels: over.levels,
    heightSource: over.heightSource ?? 'levels',
    tier: over.tier ?? 'generic',
    lat: 40.7,
    lng: -74,
    wikidata: over.wikidata,
    tags: over.tags ?? { building: 'yes' },
  }
}

function ctx(region: keyof typeof REGION_PACKS = 'us', climate: ResolvedContext['climate'] = 'temperate', zone: ZoneKind = 'commercial'): ResolvedContext {
  return {
    matrixVersion: 'test',
    region: REGION_PACKS[region],
    climate,
    treePool: [],
    treePoolSource: 'climate-default',
    landCoverSource: 'osm-derived',
    landCoverAt: () => 'built',
    zoneAt: () => zone,
    provenance: [],
  }
}

beforeEach(() => clearRecognizerCache())

describe('priors', () => {
  it('normalizes OSM roof:shape to buildable forms', () => {
    expect(normalizeRoofShape('gabled')).toBe('gabled')
    expect(normalizeRoofShape('half-hipped')).toBe('hipped')
    expect(normalizeRoofShape('onion')).toBe('dome')
    expect(normalizeRoofShape('gambrel')).toBe('mansard')
    expect(normalizeRoofShape('nonsense')).toBeUndefined()
    expect(normalizeRoofShape(undefined)).toBeUndefined()
  })

  it('reads architecture / material / roof / wikidata signals from tags', () => {
    const b = building({
      id: 'bld_1',
      tags: {
        building: 'apartments',
        'building:architecture': 'art_nouveau',
        'roof:shape': 'gabled',
        'building:material': 'brick',
      },
      wikidata: 'Q42',
    })
    setWikidataStyle('Q42', 'Brutalist architecture')
    const p = gatherPriors(b, ctx(), { wikidataStyle: 'Brutalist architecture' })
    expect(p.buildingType).toBe('apartments')
    expect(p.architectureTag).toBe('art_nouveau')
    expect(p.roofShapeTag).toBe('gabled')
    expect(p.facadeMaterialTag).toBe('brick')
    expect(p.wikidataStyle).toBe('Brutalist architecture')
    expect(p.massingSource).toBe('osm-extrusion')
  })
})

describe('descriptor synthesis', () => {
  it('is deterministic per building and varies between buildings', () => {
    const p1 = gatherPriors(building({ id: 'bld_det' }), ctx())
    const a = describeFromPriors(p1)
    const b = describeFromPriors(p1)
    expect(a).toEqual(b)
    const p2 = gatherPriors(building({ id: 'bld_other', heightM: 60, levels: 18 }), ctx())
    expect(describeFromPriors(p2).style).not.toEqual(a.style)
  })

  it('maps building:architecture=brutalist → brutalist concrete', () => {
    const p = gatherPriors(
      building({ id: 'bld_brutal', tags: { building: 'office', 'building:architecture': 'brutalist' } }),
      ctx(),
    )
    const d = describeFromPriors(p)
    expect(d.style).toBe('brutalist-concrete')
    expect(d.material).toBe('concrete')
    expect(d.era).toBe('midcentury')
    expect(d.confidence).toBeGreaterThanOrEqual(0.75) // 0.8 base ± id-seeded jitter
  })

  it('honors OSM roof:shape=dome as the roof form', () => {
    const p = gatherPriors(
      building({ id: 'bld_dome', heightM: 18, tags: { building: 'church', 'roof:shape': 'dome' } }),
      ctx('eu-south', 'mediterranean', 'none'),
    )
    const d = describeFromPriors(p)
    expect(d.roofForm).toBe('dome')
    expect(d.features).toContain('dome')
  })

  it('infers a glass high-rise from many levels when untagged', () => {
    const p = gatherPriors(building({ id: 'bld_tall', heightM: 120, levels: 34 }), ctx())
    const d = describeFromPriors(p)
    expect(['modernist-glass', 'corporate-highrise']).toContain(d.style)
    expect(d.material).toBe('glass')
    expect(d.roofForm).toBe('flat')
  })

  it('produces a concise prompt including floors and material', () => {
    const p = gatherPriors(building({ id: 'bld_prompt', levels: 5, tags: { building: 'apartments', 'building:material': 'brick' } }), ctx('eu-west'))
    const d = describeFromPriors(p)
    expect(d.prompt).toMatch(/5 floors/)
    expect(d.prompt).toMatch(/brick facade/)
  })
})

describe('fallback chain (recognizeBuilding)', () => {
  it('picks the descriptor-facade path when the library flag is off', () => {
    const plan = recognizeBuilding(building({ id: 'bld_off', heightM: 12 }), ctx(), { libraryEnabled: false })
    expect(plan.buildPath).toBe('descriptor-facade')
    expect(plan.libraryEligible).toBe(true)
  })

  it('picks the library-match path when the flag is on and the building is low-rise', () => {
    const plan = recognizeBuilding(building({ id: 'bld_lib', heightM: 12 }), ctx(), { libraryEnabled: true })
    expect(plan.buildPath).toBe('library-match')
  })

  it('never sends a tall building to a fit-to-slot library asset', () => {
    const plan = recognizeBuilding(building({ id: 'bld_hi', heightM: 120, levels: 34 }), ctx(), { libraryEnabled: true })
    expect(plan.libraryEligible).toBe(false)
    expect(plan.buildPath).toBe('descriptor-facade')
  })

  it('recommends a Sketchfab search when there is no reference photo', () => {
    const plan = recognizeBuilding(building({ id: 'bld_nophoto' }), ctx(), { libraryEnabled: false })
    expect(plan.recommendedUpgrade).toBe('sketchfab-search')
    expect(plan.sketchfabQuery.length).toBeGreaterThan(0)
  })

  it('recommends photo-generate when a reference photo exists', () => {
    const plan = recognizeBuilding(building({ id: 'bld_photo' }), ctx(), {
      libraryEnabled: false,
      photoUrl: 'https://example.org/photo.jpg',
    })
    expect(plan.recommendedUpgrade).toBe('photo-generate')
  })

  it('keeps only flat roofs on tall masses (no roof cap above ~25 m)', () => {
    const plan = recognizeBuilding(building({ id: 'bld_flatroof', heightM: 40, tags: { building: 'apartments', 'roof:shape': 'gabled' } }), ctx('eu-west'), { libraryEnabled: false })
    expect(plan.roofForm).toBe('flat')
  })

  it('produces a valid resolution (facade/roof from the material library sets)', () => {
    const plan = recognizeBuilding(building({ id: 'bld_res', tags: { building: 'office', 'building:architecture': 'brutalist' } }), ctx(), { libraryEnabled: false })
    const FACADES = ['brick-red', 'brick-brown', 'stucco-warm', 'stucco-cool', 'concrete-panel', 'office-glass', 'curtainwall-dark', 'storefront-mixed']
    const ROOFS = ['bitumen-dark', 'tile-red', 'metal-pale', 'concrete-pale']
    expect(FACADES).toContain(plan.resolution.facade)
    expect(ROOFS).toContain(plan.resolution.roof)
    expect(plan.resolution.provenance.some((l) => l.startsWith('recognizer:'))).toBe(true)
  })

  it('caches the plan per building (same reference on repeat)', () => {
    const b = building({ id: 'bld_cache' })
    const first = recognizeBuilding(b, ctx(), { libraryEnabled: false })
    const second = recognizeBuilding(b, ctx(), { libraryEnabled: false })
    expect(first).toBe(second)
  })

  it('folds Wikidata architectural style into the descriptor', () => {
    setWikidataStyle('Q999', 'Gothic architecture')
    const plan = recognizeBuilding(building({ id: 'bld_wd', wikidata: 'Q999', heightM: 22, tags: { building: 'cathedral' } }), ctx('eu-west'), { libraryEnabled: false })
    expect(plan.descriptor.style).toBe('prewar-masonry')
    expect(plan.descriptor.era).toBe('historic')
    expect(plan.confidence).toBeGreaterThanOrEqual(0.85)
  })
})

describe('roof-form geometry', () => {
  const res: BuildingResolution = {
    facade: 'brick-red', roof: 'tile-red', tint: '#b56a4f',
    uvSeed: [0, 0], provenance: [], confidence: 0.8,
  }
  const fp: Vec2[] = square(14)
  const c = { x: 7, z: 7 }

  it('builds no cap for a flat roof', () => {
    expect(buildRoofCap(fp, c, 'flat', 12, res)).toBeNull()
  })

  it.each(['gabled', 'hipped', 'pyramidal', 'mansard', 'skillion', 'dome'] as const)(
    'builds a finite, non-empty cap mesh for %s',
    (form) => {
      const cap = buildRoofCap(fp, c, form, 12, res)
      expect(cap).not.toBeNull()
      const pos = cap!.geometry.getAttribute('position')
      expect(pos.count).toBeGreaterThan(0)
      for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true)
    },
  )

  it('skips caps on tiny footprints', () => {
    expect(buildRoofCap(square(1), { x: 0.5, z: 0.5 }, 'hipped', 6, res)).toBeNull()
  })

  it('wraps the building in a group for a roof cap or a flat-roof cornice; plain mesh only when nothing is added', () => {
    const withCap = buildProceduralBuilding(building({ id: 'bld_cap', heightM: 10 }), res, 'hipped')
    expect(withCap.type).toBe('Group')
    expect((withCap as any).children.length).toBe(2) // mass + cap
    // a flat roof on a readable footprint now gets a projecting cornice (relief at
    // eye level), so it wraps in a group too (mass + cornice).
    const flat = buildProceduralBuilding(building({ id: 'bld_flat', heightM: 10, footprint: square(14) }), res, 'flat')
    expect(flat.type).toBe('Group')
    expect((flat as any).children.length).toBe(2) // mass + cornice
    // a tiny flat footprint is too small to carry a cornice → plain mesh, no wrap.
    const tiny = buildProceduralBuilding(building({ id: 'bld_tiny', heightM: 10, footprint: square(2) }), res, 'flat')
    expect(tiny.type).toBe('Mesh')
  })
})

describe('feature flag', () => {
  it('ships with the local asset library OFF by default', () => {
    expect(useEditor.getState().useLibraryAssets).toBe(false)
  })
})
