// Live Overpass fetch for a user-selected bounding box, with mirror fallback
// and a small localStorage cache so the last city survives a reload.

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

export interface FetchOptions {
  trees: boolean
  signals: boolean
}

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

function buildQuery(b: BBox, opts: FetchOptions): string {
  const bbox = `(${b.south},${b.west},${b.north},${b.east})`
  const parts = [
    `way["building"]${bbox};`,
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service|footway|cycleway)$"]${bbox};`,
    // land use / land cover polygons: rendered (water, parks) + zoning context
    `way["landuse"~"^(residential|commercial|retail|industrial|grass|forest|meadow|reservoir)$"]${bbox};`,
    `way["natural"~"^(water|wood|grassland|coastline|wetland|beach|sand)$"]${bbox};`,
    // streams/ditches/drains deliberately not fetched: never rendered as water
    `way["waterway"~"^(river|canal|riverbank)$"]${bbox};`,
    `way["leisure"~"^(park|garden|pitch|playground)$"]${bbox};`,
    // multipolygon area relations: big rivers/lakes and most large parks are
    // relations, not closed ways — without these the Vltava/Thames simply end
    // mid-scene. Member geometry comes back in full and is clipped at ingest.
    `relation["natural"~"^(water|wood)$"]${bbox};`,
    `relation["waterway"="riverbank"]${bbox};`,
    `relation["landuse"~"^(grass|forest|meadow|reservoir)$"]${bbox};`,
    `relation["leisure"~"^(park|garden)$"]${bbox};`,
    `way["barrier"~"^(fence|wall)$"]${bbox};`,
    `way["amenity"="fountain"]${bbox};`,
    `node["highway"="street_lamp"]${bbox};`,
    `node["amenity"~"^(bench|waste_basket|fountain)$"]${bbox};`,
    `node["highway"="bus_stop"]${bbox};`,
    `node["historic"~"^(memorial|monument)$"]${bbox};`,
    `node["tourism"="artwork"]${bbox};`,
    `way["historic"~"^(memorial|monument)$"]${bbox};`,
    // FAITHFUL traffic tier (Road-updates.md §8): regulatory signs, crossings and
    // explicit sign nodes. Always fetched — they are core to a driving trainer.
    `node["highway"="stop"]${bbox};`,
    `node["highway"="give_way"]${bbox};`,
    `node["highway"="crossing"]${bbox};`,
    `node["traffic_sign"]${bbox};`,
  ]
  if (opts.signals) parts.push(`node["highway"="traffic_signals"]${bbox};`)
  if (opts.trees) parts.push(`node["natural"="tree"]${bbox};`)
  return `[out:json][timeout:50];(${parts.join('')});out body geom;`
}

const KM_PER_DEG_LAT = 110.574
// One Overpass query comfortably handles a few km²; only split areas ABOVE this.
// Fragmenting small areas into many queries just triggers Overpass's per-IP rate
// limit (429) — the opposite of faster. See the fetch strategy below.
const SINGLE_QUERY_MAX_KM2 = 6
const TILE_KM = 2.6 // tile size for genuinely large areas (few, big tiles)
const TILE_CONCURRENCY = 2 // Overpass free tier allows ~2 slots per IP — do not exceed
const ATTEMPT_TIMEOUT_MS = 15000 // abort a slow/hung mirror fast; the retry round then re-races all mirrors

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One mirror attempt with a hard client-side abort timeout. Rejects on any non-2xx. */
async function attempt(url: string, body: string, ctrl: AbortController): Promise<any[]> {
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // 429/504/… → reject so a racing mirror can win
    const json = await res.json()
    if (!json.elements) throw new Error('Malformed Overpass response')
    return json.elements as any[]
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One Overpass query.
 * - race=true (small single-query areas): fire ALL mirrors at once and take the
 *   first that returns valid data — turns "sum of mirror times" into "fastest
 *   mirror", so one overloaded server (504) never dominates. Losers are aborted.
 * - race=false (tiles of a large area): sequential fallback at low concurrency,
 *   so we don't multiply Overpass load and trip its per-IP rate limit.
 * Both do one backoff+retry round on total failure.
 */
async function fetchTile(bbox: BBox, opts: FetchOptions, race: boolean, retries = 1): Promise<any[]> {
  const body = 'data=' + encodeURIComponent(buildQuery(bbox, opts))
  let lastError: unknown = null
  for (let round = 0; round <= retries; round++) {
    if (race) {
      const ctrls = MIRRORS.map(() => new AbortController())
      try {
        const elements = await Promise.any(MIRRORS.map((url, i) => attempt(url, body, ctrls[i])))
        ctrls.forEach((c) => c.abort()) // stop the losing mirrors
        return elements
      } catch (e) {
        ctrls.forEach((c) => c.abort())
        lastError = e instanceof AggregateError ? e.errors[e.errors.length - 1] : e
      }
    } else {
      for (let i = 0; i < MIRRORS.length; i++) {
        try {
          return await attempt(MIRRORS[i], body, new AbortController())
        } catch (e) {
          lastError = e
          await sleep(400)
        }
      }
    }
    if (round < retries) await sleep(1500)
  }
  throw new Error(String(lastError))
}

/**
 * Fetch OSM data for a bbox. A reasonable area (≤ SINGLE_QUERY_MAX_KM2) is ONE
 * query — fastest and least likely to be rate-limited. Only genuinely large
 * areas are split into a few big tiles fetched at low concurrency and merged
 * (deduped by element id). Every request has a client-side timeout so a slow or
 * overloaded Overpass server can never hang the build.
 */
export async function fetchOsmArea(
  bbox: BBox,
  opts: FetchOptions,
  onStatus: (msg: string) => void,
): Promise<any> {
  const midLat = (bbox.south + bbox.north) / 2
  const kmPerLng = 111.32 * Math.cos((midLat * Math.PI) / 180)
  const wKm = (bbox.east - bbox.west) * kmPerLng
  const hKm = (bbox.north - bbox.south) * KM_PER_DEG_LAT
  const areaKm2 = wKm * hKm
  const nx = areaKm2 > SINGLE_QUERY_MAX_KM2 ? Math.max(1, Math.ceil(wKm / TILE_KM)) : 1
  const ny = areaKm2 > SINGLE_QUERY_MAX_KM2 ? Math.max(1, Math.ceil(hKm / TILE_KM)) : 1

  // reasonable area: a single query, raced across all mirrors (fastest wins)
  if (nx * ny <= 1) {
    onStatus('Querying OpenStreetMap for your area…')
    const elements = await fetchTile(bbox, opts, true).catch((e) => {
      throw new Error(`OpenStreetMap is busy right now (${e}). Retry in a moment, or pick a smaller area.`)
    })
    return { elements }
  }

  // large area: a few big tiles, low concurrency (respect Overpass rate limits)
  const tiles: BBox[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      tiles.push({
        west: bbox.west + ((bbox.east - bbox.west) * ix) / nx,
        east: bbox.west + ((bbox.east - bbox.west) * (ix + 1)) / nx,
        south: bbox.south + ((bbox.north - bbox.south) * iy) / ny,
        north: bbox.south + ((bbox.north - bbox.south) * (iy + 1)) / ny,
      })
    }
  }

  const merged = new Map<string, any>()
  let done = 0
  const report = () => onStatus(`Downloading map data… ${done}/${tiles.length} tiles`)
  report()

  let cursor = 0
  const worker = async () => {
    while (cursor < tiles.length) {
      const t = tiles[cursor++]
      const elements = await fetchTile(t, opts, false).catch((e) => {
        throw new Error(`OpenStreetMap is busy right now (${e}). Retry in a moment, or pick a smaller area.`)
      })
      for (const el of elements) merged.set(`${el.type}/${el.id}`, el) // dedup ways/nodes across tile seams
      done++
      report()
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, worker))

  return { elements: [...merged.values()] }
}

// ---- last-city cache (best effort; skipped when over localStorage quota) ----

const CACHE_KEY = 'cb_city_cache_v1'

export interface CachedCity {
  name: string
  raw: any
}

export function cacheCity(name: string, raw: any): void {
  if (typeof localStorage === 'undefined') return // headless (Node API/CLI): no browser cache
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ name, raw }))
  } catch {
    localStorage.removeItem(CACHE_KEY)
  }
}

export function loadCachedCity(): CachedCity | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const s = localStorage.getItem(CACHE_KEY)
    if (!s) return null
    const c = JSON.parse(s)
    if (c && c.name && c.raw?.elements) return c
  } catch {}
  return null
}
