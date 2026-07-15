import type { RoadSegment } from '../types'

// Landmark catalog (scaffold): maps well-known named / wikidata-tagged OSM
// features to a recognizable 3D treatment so famous places read at first
// glance instead of rendering as generic geometry. Two kinds of treatment:
//
//  - procedural categories ('suspension-bridge', 'cable-stayed-bridge') are
//    rendered by dedicated generators (see procgen/bridges.ts) with
//    landmark-specific styling (colour, proportions);
//  - 'gltf' entries point at a curated model to drop in later (assetPath) — the
//    extension hook for hand-authored / licensed landmark meshes.
//
// Extend LANDMARKS to cover more landmarks; no other code changes are required.
// wikidata QIDs are the stable key (they survive OSM renames); namePattern is a
// fallback for features that carry only a name.

export type LandmarkCategory = 'suspension-bridge' | 'cable-stayed-bridge' | 'gltf'

export interface LandmarkEntry {
  id: string
  label: string
  wikidata?: string[] // preferred, stable key
  namePattern?: RegExp // fallback name match (case-insensitive)
  category: LandmarkCategory
  color?: string // structure colour for procedural bridge categories
  assetPath?: string // curated GLB for 'gltf' category (scaffold)
  sketchfabQuery?: string // suggested search query when the user swaps the asset
}

const INTERNATIONAL_ORANGE = '#c0362c' // the Golden Gate's actual paint colour

export const LANDMARKS: LandmarkEntry[] = [
  {
    id: 'golden-gate-bridge',
    label: 'Golden Gate Bridge',
    wikidata: ['Q44440'],
    namePattern: /golden\s*gate\s*bridge/i,
    category: 'suspension-bridge',
    color: INTERNATIONAL_ORANGE,
    sketchfabQuery: 'golden gate bridge',
  },
  {
    id: 'brooklyn-bridge',
    label: 'Brooklyn Bridge',
    wikidata: ['Q123067'],
    namePattern: /brooklyn\s*bridge/i,
    category: 'suspension-bridge',
    color: '#9a8c78',
    sketchfabQuery: 'brooklyn bridge',
  },
  {
    id: 'tower-bridge',
    label: 'Tower Bridge',
    wikidata: ['Q83125'],
    namePattern: /\btower\s*bridge\b/i,
    category: 'suspension-bridge',
    color: '#5f6fa0',
    sketchfabQuery: 'tower bridge london',
  },
  {
    id: 'verrazzano-narrows',
    label: 'Verrazzano-Narrows Bridge',
    wikidata: ['Q391137'],
    namePattern: /verrazz?ano/i,
    category: 'suspension-bridge',
    color: '#9a9ea3',
    sketchfabQuery: 'verrazzano narrows bridge',
  },
  {
    id: 'george-washington-bridge',
    label: 'George Washington Bridge',
    wikidata: ['Q460655'],
    namePattern: /george\s*washington\s*bridge/i,
    category: 'suspension-bridge',
    color: '#9a9ea3',
    sketchfabQuery: 'george washington bridge',
  },
]

const norm = (s: string) => s.toLowerCase().trim()

/** Match a named/wikidata/structure-tagged feature to a landmark, or null. */
export function findLandmark(name?: string, wikidata?: string, structure?: string): LandmarkEntry | null {
  if (wikidata) {
    const byQid = LANDMARKS.find((l) => l.wikidata?.includes(wikidata))
    if (byQid) return byQid
  }
  if (name) {
    const n = norm(name)
    const byName = LANDMARKS.find((l) => l.namePattern?.test(name) || norm(l.label) === n)
    if (byName) return byName
  }
  // generic structural fallback: any bridge explicitly tagged as a suspension /
  // cable-stayed structure still gets the dedicated generator (steel grey).
  if (structure === 'suspension') {
    return { id: `suspension:${name ?? 'unnamed'}`, label: name ?? 'Suspension bridge', category: 'suspension-bridge', color: '#9a9ea3', sketchfabQuery: name ? `${name} bridge` : 'suspension bridge' }
  }
  if (structure === 'cable-stayed' || structure === 'cable_stayed') {
    return { id: `cable:${name ?? 'unnamed'}`, label: name ?? 'Cable-stayed bridge', category: 'cable-stayed-bridge', color: '#9a9ea3', sketchfabQuery: name ? `${name} bridge` : 'cable stayed bridge' }
  }
  return null
}

/** Landmark match for a road/bridge segment (only bridges qualify). */
export function matchBridgeLandmark(road: RoadSegment): LandmarkEntry | null {
  if (!road.bridge) return null
  return findLandmark(road.name, road.wikidata, road.structure)
}
