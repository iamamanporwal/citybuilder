import type {
  ClimateZone,
  FacadeSet,
  PropRules,
  RegionId,
  RegionPack,
  RoadSurfaceSet,
  RoofSet,
  TreeSpecies,
  WeightedVariant,
  ZoneKind,
} from './types'

// ---------------------------------------------------------------------------
// The Content Matrix — declarative, versioned, inspectable.
// Rules are ORDERED: the first matching rule wins; every consulted rule is
// recorded in the object's provenance so decisions are explainable.
// ---------------------------------------------------------------------------

export const MATRIX_VERSION = '2026.07.10-1'

// ---------- region packs ----------

export const REGION_PACKS: Record<RegionId, RegionPack> = {
  us: { id: 'us', label: 'United States', drivingSide: 'right', centerline: 'double-yellow', crosswalk: 'continental', signShape: 'us-rect', lampStyle: 'cobra' },
  uk: { id: 'uk', label: 'United Kingdom', drivingSide: 'left', centerline: 'white-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'euro-post' },
  'eu-west': { id: 'eu-west', label: 'Western Europe', drivingSide: 'right', centerline: 'white-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'euro-post' },
  'eu-central': { id: 'eu-central', label: 'Central Europe', drivingSide: 'right', centerline: 'white-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'euro-post' },
  'eu-south': { id: 'eu-south', label: 'Southern Europe', drivingSide: 'right', centerline: 'white-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'heritage' },
  jp: { id: 'jp', label: 'Japan', drivingSide: 'left', centerline: 'white-solid', crosswalk: 'ladder', signShape: 'jp-mix', lampStyle: 'cobra' },
  in: { id: 'in', label: 'India', drivingSide: 'left', centerline: 'single-yellow-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'cobra' },
  au: { id: 'au', label: 'Australia / NZ', drivingSide: 'left', centerline: 'single-yellow-dashed', crosswalk: 'ladder', signShape: 'us-rect', lampStyle: 'cobra' },
  generic: { id: 'generic', label: 'Generic', drivingSide: 'right', centerline: 'white-dashed', crosswalk: 'zebra', signShape: 'eu-circle', lampStyle: 'cobra' },
}

export const COUNTRY_TO_REGION: Record<string, RegionId> = {
  us: 'us', ca: 'us',
  gb: 'uk', ie: 'uk',
  fr: 'eu-west', nl: 'eu-west', be: 'eu-west', lu: 'eu-west',
  de: 'eu-central', at: 'eu-central', ch: 'eu-central', cz: 'eu-central', pl: 'eu-central', sk: 'eu-central', hu: 'eu-central', dk: 'eu-central', se: 'eu-central', no: 'eu-central', fi: 'eu-central',
  es: 'eu-south', pt: 'eu-south', it: 'eu-south', gr: 'eu-south', hr: 'eu-south',
  jp: 'jp', kr: 'jp',
  in: 'in', bd: 'in', pk: 'in', lk: 'in',
  au: 'au', nz: 'au',
}

// ---------- building facade rules ----------
// Predicates are data, not code — the whole table can be dumped/diffed as JSON.

export interface FacadeRule {
  id: string
  when: {
    region?: RegionId[]
    climate?: ClimateZone[]
    buildingTag?: string[] // OSM building=* values
    minLevels?: number
    maxLevels?: number
    zone?: ZoneKind[]
  }
  pool: WeightedVariant<FacadeSet>[]
  roofPool: WeightedVariant<RoofSet>[]
}

export const FACADE_RULES: FacadeRule[] = [
  {
    id: 'highrise-office',
    when: { minLevels: 9 },
    pool: [
      { value: 'office-glass', weight: 4 },
      { value: 'curtainwall-dark', weight: 3 },
      { value: 'concrete-panel', weight: 2 },
    ],
    roofPool: [{ value: 'bitumen-dark', weight: 3 }, { value: 'concrete-pale', weight: 1 }],
  },
  {
    id: 'commercial-midrise',
    when: { buildingTag: ['commercial', 'office', 'retail'], minLevels: 4 },
    pool: [
      { value: 'office-glass', weight: 2 },
      { value: 'concrete-panel', weight: 3 },
      { value: 'storefront-mixed', weight: 2 },
    ],
    roofPool: [{ value: 'bitumen-dark', weight: 3 }, { value: 'concrete-pale', weight: 2 }],
  },
  {
    id: 'retail-lowrise',
    when: { zone: ['retail', 'commercial'], maxLevels: 3 },
    pool: [
      { value: 'storefront-mixed', weight: 4 },
      { value: 'brick-red', weight: 2 },
      { value: 'stucco-warm', weight: 1 },
    ],
    roofPool: [{ value: 'bitumen-dark', weight: 2 }, { value: 'metal-pale', weight: 1 }],
  },
  {
    id: 'industrial',
    when: { buildingTag: ['industrial', 'warehouse'], },
    pool: [
      { value: 'concrete-panel', weight: 3 },
      { value: 'brick-brown', weight: 1 },
    ],
    roofPool: [{ value: 'metal-pale', weight: 3 }, { value: 'bitumen-dark', weight: 1 }],
  },
  {
    id: 'us-residential',
    when: { region: ['us'], maxLevels: 8 },
    pool: [
      { value: 'brick-red', weight: 4 },
      { value: 'brick-brown', weight: 3 },
      { value: 'stucco-warm', weight: 1 },
      { value: 'concrete-panel', weight: 1 },
    ],
    roofPool: [{ value: 'bitumen-dark', weight: 4 }, { value: 'concrete-pale', weight: 1 }],
  },
  {
    id: 'eu-south-residential',
    when: { region: ['eu-south'], maxLevels: 8 },
    pool: [
      { value: 'stucco-warm', weight: 5 },
      { value: 'stucco-cool', weight: 2 },
      { value: 'brick-brown', weight: 1 },
    ],
    roofPool: [{ value: 'tile-red', weight: 5 }, { value: 'concrete-pale', weight: 1 }],
  },
  {
    id: 'eu-residential',
    when: { region: ['eu-west', 'eu-central', 'uk'], maxLevels: 8 },
    pool: [
      { value: 'brick-brown', weight: 3 },
      { value: 'stucco-cool', weight: 3 },
      { value: 'stucco-warm', weight: 2 },
      { value: 'brick-red', weight: 1 },
    ],
    roofPool: [{ value: 'tile-red', weight: 3 }, { value: 'bitumen-dark', weight: 2 }],
  },
  {
    id: 'tropical-residential',
    when: { climate: ['tropical', 'arid'], maxLevels: 8 },
    pool: [
      { value: 'stucco-warm', weight: 4 },
      { value: 'stucco-cool', weight: 3 },
      { value: 'concrete-panel', weight: 2 },
    ],
    roofPool: [{ value: 'concrete-pale', weight: 3 }, { value: 'metal-pale', weight: 2 }],
  },
  {
    id: 'fallback-any',
    when: {},
    pool: [
      { value: 'stucco-cool', weight: 3 },
      { value: 'brick-brown', weight: 2 },
      { value: 'concrete-panel', weight: 2 },
      { value: 'stucco-warm', weight: 2 },
    ],
    roofPool: [{ value: 'bitumen-dark', weight: 3 }, { value: 'concrete-pale', weight: 1 }],
  },
]

// ---------- wall tint pools per facade set ----------

export const FACADE_TINTS: Record<FacadeSet, string[]> = {
  'brick-red': ['#b56a4f', '#a85f45', '#c07a5c', '#9c5540'],
  'brick-brown': ['#a08464', '#8f7355', '#b09372', '#7d654c'],
  'stucco-warm': ['#d9c49a', '#e0cfa8', '#ccb184', '#e6d7b4', '#d4b98e'],
  'stucco-cool': ['#c9cdc4', '#bfc6c9', '#d3d6cd', '#b4bcb8'],
  'concrete-panel': ['#b3b3ae', '#a6a8a4', '#bfbfba', '#9b9d99'],
  'office-glass': ['#c3d2db', '#b4c6d2', '#cdd8de', '#bccbd4'],
  'curtainwall-dark': ['#8b98a1', '#7e8c96', '#96a2aa', '#84929c'],
  'storefront-mixed': ['#c0a684', '#b59a78', '#c9b08e', '#a89070', '#cdb698', '#b3a184'],
}

// ---------- road surface rules ----------

export interface RoadRule {
  id: string
  when: { classIn?: string[]; surfaceTag?: string[]; region?: RegionId[] }
  pool: WeightedVariant<RoadSurfaceSet>[]
  decalDensity: number
}

export const ROAD_RULES: RoadRule[] = [
  { id: 'surface-cobble-tag', when: { surfaceTag: ['cobblestone', 'sett', 'paving_stones'] }, pool: [{ value: 'cobble', weight: 1 }], decalDensity: 0.5 },
  { id: 'surface-gravel-tag', when: { surfaceTag: ['gravel', 'dirt', 'unpaved', 'ground'] }, pool: [{ value: 'gravel', weight: 1 }], decalDensity: 0 },
  // Path pools are single-surface on purpose: paths never register junction
  // nodes, so plaza/greenway polylines overlap coplanarly — overlapping paths
  // must resolve to the SAME material for the overlap to render idempotently
  // (see procgen/roads.ts). Regional packs still differentiate (EU cobble).
  { id: 'pedestrian-eu', when: { classIn: ['pedestrian', 'living_street'], region: ['eu-west', 'eu-central', 'eu-south', 'uk'] }, pool: [{ value: 'cobble', weight: 1 }], decalDensity: 0.4 },
  { id: 'pedestrian-any', when: { classIn: ['pedestrian', 'living_street', 'footway', 'cycleway'] }, pool: [{ value: 'pavers', weight: 1 }], decalDensity: 0.2 },
  { id: 'major-roads', when: { classIn: ['motorway', 'trunk', 'primary'] }, pool: [{ value: 'asphalt-new', weight: 3 }, { value: 'asphalt-worn', weight: 1 }], decalDensity: 0.8 },
  { id: 'minor-roads', when: {}, pool: [{ value: 'asphalt-worn', weight: 3 }, { value: 'asphalt-new', weight: 2 }, { value: 'asphalt-patched', weight: 2 }], decalDensity: 1.4 },
]

// ---------- tree species pools per climate ----------

export const CLIMATE_TREES: Record<ClimateZone, WeightedVariant<TreeSpecies>[]> = {
  tropical: [
    { value: 'palm', weight: 4 },
    { value: 'broadleaf', weight: 3 },
    { value: 'acacia', weight: 1 },
  ],
  arid: [
    { value: 'palm', weight: 3 },
    { value: 'acacia', weight: 3 },
    { value: 'broadleaf', weight: 1 },
  ],
  mediterranean: [
    { value: 'columnar', weight: 3 },
    { value: 'broadleaf', weight: 3 },
    { value: 'palm', weight: 2 },
    { value: 'conifer', weight: 1 },
  ],
  temperate: [
    { value: 'broadleaf', weight: 5 },
    { value: 'columnar', weight: 2 },
    { value: 'conifer', weight: 2 },
  ],
  continental: [
    { value: 'broadleaf', weight: 4 },
    { value: 'conifer', weight: 3 },
    { value: 'columnar', weight: 1 },
  ],
  boreal: [
    { value: 'conifer', weight: 5 },
    { value: 'broadleaf', weight: 2 },
  ],
}

// ---------- zoning-aware prop rules ----------

export const ZONE_PROPS: Record<ZoneKind, PropRules> = {
  commercial: { lampSpacing: 26, benchDensity: 0.8, binDensity: 0.9, treeSpacing: 24 },
  retail: { lampSpacing: 24, benchDensity: 1.4, binDensity: 1.2, treeSpacing: 20 },
  residential: { lampSpacing: 34, benchDensity: 0.2, binDensity: 0.3, treeSpacing: 18 },
  industrial: { lampSpacing: 48, benchDensity: 0, binDensity: 0.2, treeSpacing: null },
  park: { lampSpacing: 40, benchDensity: 2.0, binDensity: 1.0, treeSpacing: null },
  none: { lampSpacing: 36, benchDensity: 0.3, binDensity: 0.4, treeSpacing: null },
}

/** Full matrix as a serializable object — for the inspector & version diffing. */
export function matrixToJSON() {
  return {
    version: MATRIX_VERSION,
    regionPacks: REGION_PACKS,
    countryToRegion: COUNTRY_TO_REGION,
    facadeRules: FACADE_RULES,
    facadeTints: FACADE_TINTS,
    roadRules: ROAD_RULES,
    climateTrees: CLIMATE_TREES,
    zoneProps: ZONE_PROPS,
  }
}
