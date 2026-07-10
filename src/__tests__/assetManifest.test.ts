import { describe, it, expect } from 'vitest'
import manifest from '../../assets/manifest.json'
import {
  pickAssetFor,
  normalizeScale,
  poolsForTag,
  libraryAsset,
  groundOffset,
} from '../resolver/assetPools'

describe('asset manifest integrity', () => {
  it('every asset has the required schema fields', () => {
    for (const a of manifest.assets as any[]) {
      expect(a.id, a.id).toBeTruthy()
      expect(a.path).toMatch(/^assets\/library\//)
      expect(a.semantic).toBeTruthy()
      expect(a.style).toBeTruthy()
      expect(Array.isArray(a.osmTags)).toBe(true)
      expect(a.license).toBeTruthy() // CC0-1.0 (Quaternius) or a CC-BY* label (Sketchfab)
      expect(a.lods.length).toBeGreaterThan(0)
      expect(a.triangles).toBeGreaterThan(0)
    }
  })

  it('every pool entry references an existing asset with no pool-excluding flag', () => {
    // `oversized` is advisory (non-metric source, normalized on placement);
    // unclassified/no-geometry/high-poly are genuine disqualifiers.
    const EXCLUDING = ['unclassified', 'no-geometry', 'high-poly']
    for (const [key, pool] of Object.entries(manifest.pools as Record<string, any>)) {
      expect(pool.entries.length, key).toBeGreaterThan(0)
      for (const e of pool.entries) {
        const a = libraryAsset(e.id)
        expect(a, `${key} → ${e.id}`).toBeTruthy()
        expect(a!.flags.some((f) => EXCLUDING.includes(f)), `${e.id} flags ${a!.flags}`).toBe(false)
        expect(e.weight).toBeGreaterThan(0)
        // non-metric assets must carry the normalize hint so placement rescales
        if (a!.flags.includes('oversized')) expect(e.normalizeScale).toBe(true)
      }
    }
  })

  it('Sketchfab-curated drivable props are pooled and pickable', () => {
    for (const tag of ['natural=tree', 'highway=street_lamp', 'highway=traffic_signals', 'amenity=bench', 'emergency=fire_hydrant']) {
      const a = pickAssetFor(tag, `node/${tag}`)
      expect(a, tag).toBeTruthy()
    }
  })

  it('assets at real-world scale: bollards under 1.5m, buildings over 10m', () => {
    for (const a of manifest.assets as any[]) {
      if (a.role === 'bollard') expect(a.sizeMeters.y).toBeLessThan(1.5)
      if (a.semantic === 'building') expect(a.sizeMeters.y).toBeGreaterThan(10)
    }
  })
})

describe('deterministic pool picking', () => {
  it('same feature id always resolves to the same asset', () => {
    const first = pickAssetFor('building=commercial', 'way/12345')
    for (let i = 0; i < 20; i++) {
      expect(pickAssetFor('building=commercial', 'way/12345')!.id).toBe(first!.id)
    }
  })

  it('different feature ids produce variety across a pool', () => {
    const picked = new Set<string>()
    for (let i = 0; i < 200; i++) {
      picked.add(pickAssetFor('building=yes', `way/${i}`)!.id)
    }
    expect(picked.size).toBeGreaterThan(1)
  })

  it('uncovered tags return null (procgen fallback)', () => {
    // barrier=hedge has no library asset yet — must fall back to procgen
    expect(pickAssetFor('barrier=hedge', 'node/1')).toBeNull()
  })

  it('reference-only pools (locked roads) are never picked', () => {
    expect(pickAssetFor('highway=secondary', 'way/1')).toBeNull()
    expect(poolsForTag('highway=secondary').every(p => p.pool.referenceOnly)).toBe(true)
  })
})

describe('scale normalization', () => {
  const bollard = pickAssetFor('barrier=bollard', 'node/77')!

  it('scales an asset to the feature dimensions', () => {
    const s = normalizeScale(bollard, { y: 1.0 })
    expect(s.y * bollard.sizeMeters!.y).toBeCloseTo(1.0, 5)
    expect(s.x).toBeCloseTo(s.y, 5) // unknown axes keep proportions
  })

  it('clamps runaway up-scaling but allows shrink-to-fit for non-metric assets', () => {
    // upper clamp guards a mis-tagged feature from exploding a real-scale asset
    const s = normalizeScale(bollard, { y: 500 })
    expect(s.y).toBeLessThanOrEqual(4)
    // a 1000x-scale Sketchfab prop must be allowed to shrink far below 1
    const huge = { ...bollard, sizeMeters: { x: 500, y: 1000, z: 500 } }
    const t = normalizeScale(huge, { y: 6 }) // fit a 1000m asset to a 6m lamp
    expect(t.y).toBeCloseTo(0.006, 4)
    expect(t.y * huge.sizeMeters!.y).toBeCloseTo(6, 3)
  })

  it('grounding lifts the scaled bbox min to y=0', () => {
    const a = libraryAsset('quaternius-downtown-city-megakit/Sidewalk_Straight_3m')!
    expect(groundOffset(a, 2)).toBeCloseTo(a.groundOffsetY * 2, 6)
  })
})
