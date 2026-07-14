import type { BuildingFeature } from '../types'
import type { BuildingResolution, FacadeSet, RegionId, ResolvedContext, RoofSet } from '../resolver/types'
import { resolveBuilding } from '../resolver/resolve'
import { hash01, pickWeighted } from '../resolver/resolve'
import { FACADE_TINTS } from '../resolver/matrix'
import { gatherPriors } from './priors'
import { describeFromPriors, describeWithVlm, VLM } from './descriptor'
import type {
  AppearancePlan,
  ArchStyle,
  BuildingDescriptor,
  MaterialClass,
  RoofForm,
} from './types'

// The Building Recognizer orchestrator (PRD §7F).
//
// Runs the fallback chain and produces one AppearancePlan per building:
//   1. gather structured priors (OSM + region + wikidata style + massing)
//   2. descriptor  ← VLM(photo, priors)  OR  synthesize from priors
//   3. map descriptor → concrete material sets + a build path; recommend the
//      best on-demand upgrade (photo→generate, or seed a Sketchfab search)
//   4. no library asset / no photo → the descriptor drives a procedural facade
//
// Descriptors AND plans are cached per building (the descriptor cache is the
// "cache descriptors per building" the spec asks for; the plan cache avoids
// recomputing the mapping on rebuilds). Wikidata style lookups are cached
// separately because they survive across rebuilds (network cost).

// height ceiling for a fit-to-slot library asset (kept in sync with
// libraryTemplates.MAX_LIBRARY_BUILDING_H — a tall tower would look squashed).
const LIBRARY_HEIGHT_CEIL = 45

const descriptorCache = new Map<string, BuildingDescriptor>()
const planCache = new Map<string, AppearancePlan>()
const wikidataStyleCache = new Map<string, string | null>()
const wikidataPhotoCache = new Map<string, string | null>()

/** Cleared at the start of every buildScene (descriptors + plans are scene-scoped). */
export function clearRecognizerCache(): void {
  descriptorCache.clear()
  planCache.clear()
  // wikidataStyleCache intentionally persists — it's network-fetched and stable.
}

export function cachedDescriptor(id: string): BuildingDescriptor | undefined {
  return descriptorCache.get(id)
}

export function cachedPlan(id: string): AppearancePlan | undefined {
  return planCache.get(id)
}

/** Store a Wikidata architectural-style label for a QID (from the async prepass). */
export function setWikidataStyle(qid: string, style: string | null): void {
  wikidataStyleCache.set(qid, style)
}

export function getWikidataStyle(qid: string | undefined): string | undefined {
  if (!qid) return undefined
  return wikidataStyleCache.get(qid) ?? undefined
}

/** Store a Wikidata P18 reference-photo URL for a QID (from the async prepass). */
export function setWikidataPhoto(qid: string, url: string | null): void {
  wikidataPhotoCache.set(qid, url)
}

export function getWikidataPhoto(qid: string | undefined): string | undefined {
  if (!qid) return undefined
  return wikidataPhotoCache.get(qid) ?? undefined
}

// ---------- descriptor → material library mapping ----------

/** Weighted FacadeSet pool per (material, style) — id-seeded so neighbors vary. */
function facadeForDescriptor(d: BuildingDescriptor, id: string): FacadeSet {
  const pool = FACADE_POOLS[d.material]
  return pickWeighted(pool, hash01(id + ':rec:facade'))
}

const FACADE_POOLS: Record<MaterialClass, { value: FacadeSet; weight: number }[]> = {
  glass: [
    { value: 'office-glass', weight: 3 },
    { value: 'curtainwall-dark', weight: 2 },
  ],
  concrete: [
    { value: 'concrete-panel', weight: 4 },
    { value: 'curtainwall-dark', weight: 1 },
  ],
  brick: [
    { value: 'brick-red', weight: 3 },
    { value: 'brick-brown', weight: 3 },
  ],
  stone: [
    { value: 'stucco-cool', weight: 3 },
    { value: 'concrete-panel', weight: 2 },
  ],
  stucco: [
    { value: 'stucco-warm', weight: 3 },
    { value: 'stucco-cool', weight: 2 },
  ],
  metal: [
    { value: 'concrete-panel', weight: 2 },
    { value: 'curtainwall-dark', weight: 1 },
  ],
  mixed: [
    { value: 'storefront-mixed', weight: 3 },
    { value: 'brick-brown', weight: 2 },
    { value: 'concrete-panel', weight: 1 },
  ],
}

/** RoofSet driven by roof form + material + climate. */
function roofForDescriptor(d: BuildingDescriptor, region: RegionId): RoofSet {
  if (d.roofForm === 'gabled' || d.roofForm === 'hipped' || d.roofForm === 'mansard') {
    // pitched roofs read as tile in the Mediterranean/EU, else dark shingle
    if (d.style === 'mediterranean' || region === 'eu-south') return 'tile-red'
    return d.material === 'metal' ? 'metal-pale' : 'tile-red'
  }
  if (d.roofForm === 'skillion') return 'metal-pale'
  if (d.roofForm === 'dome') return 'concrete-pale'
  // flat
  if (d.material === 'concrete' || d.material === 'stone') return 'concrete-pale'
  return 'bitumen-dark'
}

function tintForFacade(facade: FacadeSet, id: string): string {
  const tints = FACADE_TINTS[facade]
  return tints[Math.floor(hash01(id + ':rec:tint') * tints.length) % tints.length]
}

function sketchfabQueryFor(d: BuildingDescriptor, type: string): string {
  const noun = type && type !== 'yes' ? type.replace(/_/g, ' ') : 'building'
  return `${d.style.replace(/-/g, ' ')} ${noun}`
}

// ---------- the plan ----------

export interface RecognizeOpts {
  libraryEnabled: boolean
  photoUrl?: string
}

/**
 * Produce the appearance plan for one building. Deterministic and synchronous:
 * the async signals (wikidata style, photo) are read from caches populated by
 * the prepass, so this can run inside the synchronous scene build.
 */
export function recognizeBuilding(b: BuildingFeature, ctx: ResolvedContext, opts: RecognizeOpts): AppearancePlan {
  const cached = planCache.get(b.id)
  if (cached) return cached

  const baseline = resolveBuilding(b, ctx)
  const priors = gatherPriors(b, ctx, {
    wikidataStyle: getWikidataStyle(b.wikidata),
    photoUrl: opts.photoUrl ?? getWikidataPhoto(b.wikidata),
  })

  let descriptor = descriptorCache.get(b.id)
  if (!descriptor) {
    // Stage 2: a real VLM answers when configured + a photo exists; otherwise
    // the descriptor is synthesized from priors. (The real async VLM call runs
    // on-demand via recognizeBuildingWithPhoto; build-time stays synchronous.)
    descriptor = describeFromPriors(priors)
    descriptorCache.set(b.id, descriptor)
  }

  const libraryEligible = b.heightM <= LIBRARY_HEIGHT_CEIL

  // Whether the descriptor's own evidence is strong enough to OVERRIDE the
  // generic resolver pick. Weak evidence keeps the resolver's look (no regress).
  const strongEvidence = descriptor.confidence >= 0.6
  const facade: FacadeSet = strongEvidence ? facadeForDescriptor(descriptor, b.id) : baseline.facade
  const roof: RoofSet = strongEvidence ? roofForDescriptor(descriptor, priors.region) : baseline.roof
  const tint = strongEvidence ? tintForFacade(facade, b.id) : baseline.tint
  // Roof geometry only for low/mid-rise; tall buildings stay flat masses.
  const roofForm: RoofForm = b.heightM <= 25 ? descriptor.roofForm : 'flat'

  // ---- fallback chain: which path fills the slot NOW, and what to upgrade to
  const buildPath = opts.libraryEnabled && libraryEligible ? 'library-match' : 'descriptor-facade'
  const recommendedUpgrade =
    priors.hasPhoto ? 'photo-generate' : buildPath === 'descriptor-facade' ? 'sketchfab-search' : 'none'

  const provenance: string[] = [
    `recognizer: ${descriptor.style} / ${descriptor.material} / ${descriptor.roofForm} roof / ${descriptor.floors} floors / ${descriptor.era}`,
    `descriptor source: ${descriptor.source === 'vlm' ? 'vision-language model' : priors.hasPhoto ? 'priors (VLM endpoint not configured — photo available for upgrade)' : 'structured priors (no photo)'}`,
    `signals: type=${priors.buildingType}` +
      (priors.architectureTag ? `, architecture=${priors.architectureTag}` : '') +
      (priors.wikidataStyle ? `, wikidata-style=${priors.wikidataStyle}` : '') +
      (priors.roofShapeTag ? `, roof:shape=${priors.roofShapeTag}` : '') +
      (priors.facadeMaterialTag ? `, material=${priors.facadeMaterialTag}` : '') +
      `, region=${priors.region}, climate=${priors.climate}, zone=${priors.zone}, ${priors.heightConfident ? 'measured' : 'estimated'} height`,
    `appearance: ${strongEvidence ? 'descriptor-driven' : 'resolver baseline (low descriptor confidence)'} — ${facade} / ${roof}${roofForm !== 'flat' ? ` / ${roofForm} cap` : ''}`,
    `path: ${buildPath}${recommendedUpgrade !== 'none' ? ` (upgrade → ${recommendedUpgrade})` : ''}`,
    ...(VLM.available ? [] : [`VLM: ${VLM.reason}`]),
  ]

  const resolution: BuildingResolution = {
    facade,
    roof,
    tint,
    uvSeed: baseline.uvSeed,
    provenance,
    confidence: strongEvidence ? descriptor.confidence : baseline.confidence,
  }

  const plan: AppearancePlan = {
    buildPath,
    recommendedUpgrade,
    descriptor,
    resolution,
    roofForm,
    facade,
    roof,
    tint,
    libraryEligible,
    sketchfabQuery: sketchfabQueryFor(descriptor, priors.buildingType),
    generationPrompt: descriptor.prompt,
    provenance,
    confidence: resolution.confidence,
  }
  planCache.set(b.id, plan)
  return plan
}

/**
 * On-demand Stage 2 with the REAL vision-language model. When a VLM endpoint is
 * configured and the building has a reference photo, this replaces the priors-
 * synthesized descriptor with the model's, drops the stale plan, and returns the
 * re-planned appearance. A no-op (returns the existing sync plan) when no VLM or
 * no photo — the UI still has the descriptor prompt to seed Sketchfab/generation.
 */
export async function recognizeWithVlm(
  b: BuildingFeature,
  ctx: ResolvedContext,
  opts: RecognizeOpts,
): Promise<AppearancePlan> {
  const photoUrl = opts.photoUrl ?? getWikidataPhoto(b.wikidata)
  if (VLM.available && photoUrl) {
    try {
      const priors = gatherPriors(b, ctx, { wikidataStyle: getWikidataStyle(b.wikidata), photoUrl })
      const descriptor = await describeWithVlm(priors)
      descriptorCache.set(b.id, descriptor)
      planCache.delete(b.id) // force a re-plan off the new descriptor
    } catch {
      /* VLM failed — keep the priors descriptor */
    }
  }
  return recognizeBuilding(b, ctx, opts)
}
