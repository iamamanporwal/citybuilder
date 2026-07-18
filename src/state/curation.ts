// In-app asset-library curation state (persisted). The Curate studio edits this;
// the build path (buildCity → assetPools.setActiveCuration) reads it live. Replaces
// the old download-a-JSON-and-hand-it-back loop: curation now lives in the app.
//
// Per studio "kind" (tree, street_lamp, building, …):
//   enabled → use library models for this thing in the map (checkbox in the rail)
//   ids     → which curated model variants to use when enabled
// A kind that is disabled (or enabled with no ids) → the procedural generator.
import seed from '../../assets/curation-selection.json'

export interface CurationKindState {
  enabled: boolean
  ids: string[]
}
export type CurationMap = Record<string, CurationKindState>

const LS_KEY = 'cb_curation'

/** Default curation seeded from the committed picks (assets/curation-selection.json).
 *  Buildings start OFF (kept procedural) — the current default the user asked for. */
export function seedCuration(): CurationMap {
  const out: CurationMap = {}
  const byKind = (seed as { byKind?: Record<string, string[]> }).byKind ?? {}
  for (const [kind, ids] of Object.entries(byKind)) {
    out[kind] = { enabled: kind !== 'building' && kind !== 'complete', ids: [...ids] }
  }
  return out
}

export function loadCuration(): CurationMap {
  try {
    const s = typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)
    if (s) return JSON.parse(s) as CurationMap
  } catch { /* ignore */ }
  return seedCuration()
}

export function saveCuration(c: CurationMap): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(c)) } catch { /* ignore */ }
}

/** The set of asset ids the map should actually use = enabled kinds' selected ids. */
export function activeIdsOf(c: CurationMap): Set<string> {
  const ids = new Set<string>()
  for (const k of Object.values(c)) if (k.enabled) for (const id of k.ids) ids.add(id)
  return ids
}
