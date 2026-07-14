import type { BuildingResolution, ClimateZone, FacadeSet, RegionId, RoofSet, ZoneKind } from '../resolver/types'

// ---------------------------------------------------------------------------
// Building Recognizer types (PRD §7F).
//
// The recognizer decides HOW EACH BUILDING LOOKS and how its slot is filled.
// No global dataset labels architectural style, so imagery is the primary
// signal — grounded by structured data. This module models that signal fusion:
//
//   priors (OSM tags + region + wikidata + massing)  ─┐
//   optional street-view / aerial photo             ──┼─► descriptor ─► plan
//   vision-language model (when configured)          ─┘
//
// Everything here is deterministic and side-effect-free at build time; the
// network-bound steps (photo, VLM, wikidata style) run in an async prepass or
// on-demand and are cached per building.
// ---------------------------------------------------------------------------

/** Canonical architectural styles the recognizer resolves to. */
export type ArchStyle =
  | 'modernist-glass'
  | 'corporate-highrise'
  | 'brutalist-concrete'
  | 'prewar-masonry'
  | 'neoclassical'
  | 'brick-rowhouse'
  | 'mediterranean'
  | 'industrial-shed'
  | 'vernacular-residential'
  | 'contemporary-mixed' // generic fallback

/** Dominant facade material class (coarser than the material library's sets). */
export type MaterialClass = 'glass' | 'concrete' | 'brick' | 'stone' | 'stucco' | 'metal' | 'mixed'

/** Roof form — a superset of OSM roof:shape, drives both material and geometry. */
export type RoofForm = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'mansard' | 'skillion' | 'dome'

/** Construction era bucket (informs material wear, ornament, proportions). */
export type Era = 'historic' | 'prewar' | 'midcentury' | 'modern' | 'contemporary'

/**
 * Massing source for the building's 3D mass. Today every building is an OSM
 * footprint extrusion; LoD2 (PLATEAU / 3D BAG) and GlobalBuildingAtlas /
 * OpenBuildingMap massing are documented milestones that land with the bake
 * service — the field lets the descriptor record which was used.
 */
export type MassingSource = 'osm-extrusion' | 'lod2-plateau' | 'building-atlas'

/** Stage 1 — structured priors gathered per building, before any imagery. */
export interface BuildingPriors {
  id: string
  buildingType: string // OSM building=* value ('yes' when generic)
  architectureTag?: string // OSM building:architecture
  roofShapeTag?: RoofForm // OSM roof:shape, normalized
  roofMaterialTag?: string // OSM roof:material
  facadeMaterialTag?: string // OSM building:material / building:facade:material
  levels: number
  heightM: number
  heightConfident: boolean // height/levels tag present (vs estimated)
  region: RegionId
  climate: ClimateZone
  zone: ZoneKind
  wikidata?: string
  wikidataStyle?: string // resolved via Wikidata P149 (architectural style label)
  name?: string
  hasPhoto: boolean // a reference photo (street-view / aerial / Wikimedia) exists
  photoUrl?: string
  massingSource: MassingSource
}

/**
 * Stage 2 output — the structured descriptor. When a VLM + photo are wired this
 * is the model's JSON; otherwise it is synthesized deterministically from the
 * priors (source='priors'). `prompt` is the concise text used to seed Sketchfab
 * search and image-to-3D generation.
 */
export interface BuildingDescriptor {
  style: ArchStyle
  material: MaterialClass
  roofForm: RoofForm
  floors: number
  era: Era
  features: string[] // distinctive: 'cornice', 'setbacks', 'storefront', 'columns', 'balconies', 'dome'
  prompt: string
  confidence: number // 0..1 — evidence strength behind the descriptor
  source: 'vlm' | 'priors' // 'vlm' only when a real endpoint answered
}

/** What actually renders in the slot at build time. */
export type BuildPath = 'library-match' | 'descriptor-facade'

/** The best on-demand upgrade the recognizer recommends for this slot. */
export type RecommendedUpgrade = 'photo-generate' | 'sketchfab-search' | 'none'

/**
 * The full appearance plan for one building. `resolution` is a normal
 * BuildingResolution so every existing builder / lint / exporter keeps working
 * unchanged — the recognizer simply becomes the authority that produces it.
 */
export interface AppearancePlan {
  buildPath: BuildPath
  recommendedUpgrade: RecommendedUpgrade
  descriptor: BuildingDescriptor
  resolution: BuildingResolution
  roofForm: RoofForm // geometry cap for low/mid-rise (flat = no cap)
  facade: FacadeSet
  roof: RoofSet
  tint: string
  libraryEligible: boolean // height in range for a fit-to-slot library asset
  sketchfabQuery: string // seed for the Sketchfab provider
  generationPrompt: string // seed for Trellis / Meshy image-to-3D
  provenance: string[]
  confidence: number
}
