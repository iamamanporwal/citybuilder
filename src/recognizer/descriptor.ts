import { hash01 } from '../resolver/resolve'
import type { RegionId } from '../resolver/types'
import type { ArchStyle, BuildingDescriptor, BuildingPriors, Era, MaterialClass, RoofForm } from './types'

// Stage 2 of the recognizer: priors (+ optional photo) → a structured descriptor.
//
// Two implementations behind one shape:
//   • describeWithVlm()   — the real seam. POSTs photo + priors to a
//                           vision-language endpoint that returns the JSON
//                           descriptor. Disabled until VLM.available is wired.
//   • describeFromPriors() — the deterministic default. Fuses OSM architecture /
//                           material / roof tags, Wikidata style, height, region
//                           and climate into a descriptor + prompt. No network,
//                           no randomness beyond hash01(id) tie-breaks — so the
//                           same building always resolves the same way.
//
// This mirrors the generation gateway (providers.ts): a real GPU/endpoint is
// config, not code — the simulation is a faithful stand-in until a key lands.

export interface VlmConfig {
  available: boolean
  endpoint?: string
  model?: string
  reason?: string
}

/**
 * Vision-language descriptor provider. Off by default: set an endpoint (e.g.
 * VITE_VLM_ENDPOINT in .env, or a Settings field) to a service that accepts
 * {imageUrl, priors} and returns a BuildingDescriptor. Until then the recognizer
 * synthesizes the descriptor from structured priors — see describeFromPriors.
 */
export const VLM: VlmConfig = {
  available: !!import.meta.env?.VITE_VLM_ENDPOINT,
  endpoint: import.meta.env?.VITE_VLM_ENDPOINT,
  model: import.meta.env?.VITE_VLM_MODEL ?? 'claude-opus-4-8',
  reason: 'Needs a vision-language endpoint (photo + priors → descriptor). Set VITE_VLM_ENDPOINT to enable.',
}

/**
 * Real VLM path: send the reference photo + priors, get back a structured
 * descriptor. Throws if the endpoint is not configured or the response is
 * malformed — callers fall back to describeFromPriors.
 */
export async function describeWithVlm(priors: BuildingPriors): Promise<BuildingDescriptor> {
  if (!VLM.available || !VLM.endpoint) throw new Error('VLM endpoint not configured')
  if (!priors.photoUrl) throw new Error('no reference photo for VLM')
  const res = await fetch(VLM.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: VLM.model, imageUrl: priors.photoUrl, priors }),
  })
  if (!res.ok) throw new Error(`VLM endpoint ${res.status}`)
  const d = await res.json()
  // Trust-but-normalize: the endpoint returns the descriptor shape; we still
  // clamp confidence and guarantee a prompt so downstream never sees garbage.
  return {
    style: d.style,
    material: d.material,
    roofForm: d.roofForm ?? priors.roofShapeTag ?? 'flat',
    floors: d.floors ?? priors.levels,
    era: d.era ?? 'contemporary',
    features: Array.isArray(d.features) ? d.features : [],
    prompt: d.prompt ?? buildPrompt(d.era, d.style, priors.buildingType, d.floors ?? priors.levels, d.material, d.roofForm ?? 'flat', d.features ?? []),
    confidence: Math.min(1, Math.max(0, d.confidence ?? 0.9)),
    source: 'vlm',
  }
}

// ---------- deterministic (priors-only) descriptor ----------

/** Map keywords found in OSM building:architecture / Wikidata style labels → ArchStyle. */
const STYLE_KEYWORDS: [RegExp, ArchStyle][] = [
  [/brutal/i, 'brutalist-concrete'],
  [/neoclass|classical|greek revival|beaux|palladian/i, 'neoclassical'],
  [/gothic|romanesque|baroque|renaissance|victorian|edwardian|georgian|tudor|art.?nouveau|art.?deco|second empire/i, 'prewar-masonry'],
  [/modernist|international style|bauhaus|glass|curtain/i, 'modernist-glass'],
  [/mediterran|spanish|moorish|mission/i, 'mediterranean'],
  [/industrial|warehouse|factory/i, 'industrial-shed'],
  [/contemporary|postmodern|high.?tech|deconstruct/i, 'contemporary-mixed'],
]

function styleFromKeywords(...texts: (string | undefined)[]): ArchStyle | undefined {
  const hay = texts.filter(Boolean).join(' ')
  if (!hay) return undefined
  for (const [re, style] of STYLE_KEYWORDS) if (re.test(hay)) return style
  return undefined
}

const RESIDENTIAL_TYPES = new Set(['house', 'residential', 'apartments', 'detached', 'semidetached_house', 'terrace', 'dormitory', 'bungalow'])
const INDUSTRIAL_TYPES = new Set(['industrial', 'warehouse', 'factory', 'manufacture'])
const COMMERCIAL_TYPES = new Set(['commercial', 'office', 'retail', 'supermarket', 'hotel'])
const CIVIC_TYPES = new Set(['church', 'cathedral', 'chapel', 'mosque', 'temple', 'civic', 'government', 'museum', 'university', 'palace'])

/** Infer style from structure when no explicit style tag exists. */
function styleFromStructure(p: BuildingPriors): ArchStyle {
  const t = p.buildingType
  if (INDUSTRIAL_TYPES.has(t)) return 'industrial-shed'
  if (CIVIC_TYPES.has(t)) return p.region === 'eu-south' ? 'mediterranean' : 'neoclassical'
  if (p.levels >= 12) return p.heightM >= 90 ? 'corporate-highrise' : 'modernist-glass'
  if (p.levels >= 5) {
    if (COMMERCIAL_TYPES.has(t)) return 'modernist-glass'
    return isEuMasonry(p.region) ? 'prewar-masonry' : 'contemporary-mixed'
  }
  // low-rise
  if (p.climate === 'mediterranean' || p.region === 'eu-south') return 'mediterranean'
  if (RESIDENTIAL_TYPES.has(t) || p.zone === 'residential') {
    return p.region === 'us' ? 'brick-rowhouse' : 'vernacular-residential'
  }
  if (COMMERCIAL_TYPES.has(t) || p.zone === 'retail' || p.zone === 'commercial') return 'contemporary-mixed'
  return 'vernacular-residential'
}

function isEuMasonry(region: RegionId): boolean {
  return region === 'eu-west' || region === 'eu-central' || region === 'uk'
}

const MATERIAL_KEYWORDS: [RegExp, MaterialClass][] = [
  [/glass|curtain/i, 'glass'],
  [/brick/i, 'brick'],
  [/concrete|reinforced|precast/i, 'concrete'],
  [/stone|granite|limestone|marble|sandstone/i, 'stone'],
  [/stucco|plaster|render|cement_render/i, 'stucco'],
  [/metal|steel|aluminium|aluminum|cladding|corrugated/i, 'metal'],
  [/wood|timber/i, 'stucco'], // no wood facade set; render-like stand-in
]

function materialFromTag(tag: string | undefined): MaterialClass | undefined {
  if (!tag) return undefined
  for (const [re, m] of MATERIAL_KEYWORDS) if (re.test(tag)) return m
  return undefined
}

/** Default material for a style when OSM doesn't tag one. */
const STYLE_MATERIAL: Record<ArchStyle, MaterialClass> = {
  'modernist-glass': 'glass',
  'corporate-highrise': 'glass',
  'brutalist-concrete': 'concrete',
  'prewar-masonry': 'brick',
  'neoclassical': 'stone',
  'brick-rowhouse': 'brick',
  'mediterranean': 'stucco',
  'industrial-shed': 'metal',
  'vernacular-residential': 'stucco',
  'contemporary-mixed': 'mixed',
}

/** Default roof form for a style when OSM roof:shape is absent. */
function roofFromStyle(style: ArchStyle, p: BuildingPriors): RoofForm {
  // Tall buildings are flat-roofed regardless of style.
  if (p.levels >= 9 || p.heightM > 30) return 'flat'
  switch (style) {
    case 'mediterranean':
      return 'hipped'
    case 'neoclassical':
      return p.levels <= 3 ? 'hipped' : 'flat'
    case 'prewar-masonry':
      return isEuMasonry(p.region) || p.region === 'eu-south' ? 'gabled' : 'flat'
    case 'brick-rowhouse':
    case 'vernacular-residential':
      return p.climate === 'boreal' || p.climate === 'continental' ? 'gabled' : 'hipped'
    case 'industrial-shed':
      return 'skillion'
    default:
      return 'flat'
  }
}

const ERA_KEYWORDS: [RegExp, Era][] = [
  [/gothic|romanesque|baroque|renaissance|neoclass|classical|palladian/i, 'historic'],
  [/victorian|edwardian|georgian|art.?nouveau|art.?deco|beaux|second empire|tudor/i, 'prewar'],
  [/modernist|international style|bauhaus|brutal|mid.?century/i, 'midcentury'],
  [/postmodern/i, 'modern'],
  [/contemporary|high.?tech|deconstruct|parametric/i, 'contemporary'],
]

function eraFromKeywords(...texts: (string | undefined)[]): Era | undefined {
  const hay = texts.filter(Boolean).join(' ')
  if (!hay) return undefined
  for (const [re, era] of ERA_KEYWORDS) if (re.test(hay)) return era
  return undefined
}

function eraFromStructure(style: ArchStyle, material: MaterialClass): Era {
  if (material === 'glass') return 'contemporary'
  if (style === 'brutalist-concrete') return 'midcentury'
  if (style === 'prewar-masonry' || style === 'neoclassical') return 'prewar'
  if (style === 'brick-rowhouse') return 'prewar'
  return 'modern'
}

/** Distinctive features implied by style / roof / zone. */
function deriveFeatures(style: ArchStyle, roof: RoofForm, p: BuildingPriors): string[] {
  const f: string[] = []
  if (style === 'corporate-highrise' || (p.levels >= 12 && style === 'modernist-glass')) f.push('setbacks')
  if (style === 'neoclassical') f.push('columns', 'cornice')
  if (style === 'prewar-masonry' || style === 'brick-rowhouse') f.push('cornice')
  if (style === 'mediterranean') f.push('balconies')
  if ((p.zone === 'retail' || p.zone === 'commercial') && p.levels <= 3) f.push('storefront')
  if (roof === 'dome') f.push('dome')
  if (style === 'industrial-shed') f.push('loading-bays')
  return [...new Set(f)]
}

function buildPrompt(era: Era, style: ArchStyle, type: string, floors: number, material: MaterialClass, roof: RoofForm, features: string[]): string {
  const noun = type && type !== 'yes' ? type.replace(/_/g, ' ') : 'building'
  const styleWords = style.replace(/-/g, ' ')
  const roofWords = roof === 'flat' ? 'flat roof' : `${roof} roof`
  const feat = features.length ? `, ${features.join(', ')}` : ''
  return `${era} ${styleWords} ${noun}, ${floors} floors, ${material} facade, ${roofWords}${feat}`
}

/**
 * Deterministically synthesize a descriptor from priors (no photo / no VLM).
 * Confidence reflects how much real evidence backed the decision.
 */
export function describeFromPriors(p: BuildingPriors): BuildingDescriptor {
  const taggedStyle = styleFromKeywords(p.architectureTag, p.wikidataStyle)
  const style = taggedStyle ?? styleFromStructure(p)

  const material = materialFromTag(p.facadeMaterialTag) ?? STYLE_MATERIAL[style]
  const roofForm = p.roofShapeTag ?? roofFromStyle(style, p)
  const era = eraFromKeywords(p.architectureTag, p.wikidataStyle) ?? eraFromStructure(style, material)
  const floors = p.levels
  const features = deriveFeatures(style, roofForm, p)
  const prompt = buildPrompt(era, style, p.buildingType, floors, material, roofForm, features)

  // evidence-weighted confidence
  let conf = 0.4
  if (p.wikidataStyle) conf = 0.9
  else if (p.architectureTag) conf = 0.8
  else {
    if (p.facadeMaterialTag) conf += 0.15
    if (p.roofShapeTag) conf += 0.12
    if (p.buildingType !== 'yes') conf += 0.1
    if (p.heightConfident) conf += 0.08
  }
  // tiny id-seeded jitter so equally-evidenced neighbors don't all read identical
  conf = Math.min(0.95, conf + (hash01(p.id + ':conf') - 0.5) * 0.04)

  return { style, material, roofForm, floors, era, features, prompt, confidence: conf, source: 'priors' }
}
