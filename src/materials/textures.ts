import * as THREE from 'three'

// Procedural PBR texture generation (albedo / height→normal / metallic-roughness).
// All textures are CLEAN + UNLIT: no baked lighting, shadows or AO gradients —
// the game engine lights them at runtime. Deterministic (seeded, no Math.random).

export interface GeneratedTexture {
  name: string
  kind: 'albedo' | 'normal' | 'metallicRoughness' | 'decal-albedo'
  size: number
  texture: THREE.Texture
  canvas: HTMLCanvasElement
}

export const TEXTURE_REGISTRY: GeneratedTexture[] = []

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return [c, c.getContext('2d')!]
}

function register(name: string, kind: GeneratedTexture['kind'], canvas: HTMLCanvasElement, srgb: boolean): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  TEXTURE_REGISTRY.push({ name, kind, size: canvas.width, texture: tex, canvas })
  return tex
}

// deterministic PRNG per texture
function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function speckle(ctx: CanvasRenderingContext2D, size: number, r: () => number, count: number, alpha: number, light: boolean) {
  for (let i = 0; i < count; i++) {
    const v = light ? 255 : 0
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * (0.4 + r() * 0.6)})`
    const s = 1 + r() * 2
    ctx.fillRect(r() * size, r() * size, s, s)
  }
}

/** Sobel height→normal conversion (tangent space, +Y up in texture space). */
function heightToNormal(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const size = height.width
  const src = height.getContext('2d')!.getImageData(0, 0, size, size)
  const [out, octx] = makeCanvas(size)
  const dst = octx.createImageData(size, size)
  const h = (x: number, y: number) => src.data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength
      const inv = 1 / Math.hypot(dx, dy, 1)
      const i = (y * size + x) * 4
      dst.data[i] = (-dx * inv * 0.5 + 0.5) * 255
      dst.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255
      dst.data[i + 2] = (inv * 0.5 + 0.5) * 255
      dst.data[i + 3] = 255
    }
  }
  octx.putImageData(dst, 0, 0)
  return out
}

/** Uniform metallic-roughness map (glTF packing: G=roughness, B=metalness) with noise. */
function mrTexture(name: string, roughBase: number, roughVar: number, metal: number, seed: string): THREE.Texture {
  const size = 128
  const [c, ctx] = makeCanvas(size)
  const r = rng(seed)
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const rough = Math.max(0, Math.min(1, roughBase + (r() - 0.5) * roughVar))
    img.data[i * 4] = 0
    img.data[i * 4 + 1] = rough * 255
    img.data[i * 4 + 2] = metal * 255
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return register(name, 'metallicRoughness', c, false)
}

// ---------------------------------------------------------------------------
// Road & ground surfaces
// ---------------------------------------------------------------------------

// Asphalt: visible aggregate embedded in binder + a matching height→normal so
// the surface catches relief as the sun moves (the flat matte grey read as
// painted cardboard). wear 0 = new, 1 = worn (cracks), 2 = patched.
function asphaltMaps(name: string, base: string, wear: number): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng(name)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#828282'
  hctx.fillRect(0, 0, size, size)
  // aggregate: many small stones of varied grey embedded in the binder; each
  // stone is raised in the height field so the normal map shows the gravel.
  for (let i = 0; i < 9000; i++) {
    const x = r() * size
    const y = r() * size
    const s = 1 + r() * 3.2
    const g = 58 + r() * 118
    ctx.fillStyle = `rgba(${g | 0},${g | 0},${(g * 0.98) | 0},${0.45 + r() * 0.45})`
    ctx.beginPath(); ctx.arc(x, y, s / 2, 0, Math.PI * 2); ctx.fill()
    const hv = 118 + r() * 115
    hctx.fillStyle = `rgb(${hv | 0},${hv | 0},${hv | 0})`
    hctx.beginPath(); hctx.arc(x, y, s / 2, 0, Math.PI * 2); hctx.fill()
  }
  // fine dark binder grit + a few light flecks
  speckle(ctx, size, r, 3400, 0.06, false)
  speckle(ctx, size, r, 1400, 0.05, true)
  // low-frequency tonal blotches (oil sheen / repaved areas) to break the tile
  for (let i = 0; i < 16; i++) {
    const cx = r() * size
    const cy = r() * size
    const rad = size * (0.05 + r() * 0.15)
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, rad)
    g.addColorStop(0, `rgba(0,0,0,${0.05 + r() * 0.09})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill()
  }
  if (wear >= 1) {
    // cracks: dark in albedo, recessed (dark) in height so they read as grooves
    ctx.strokeStyle = 'rgba(12,12,14,0.5)'
    hctx.strokeStyle = '#4a4a4a'
    for (let i = 0; i < 5 + wear * 4; i++) {
      let x = r() * size
      let y = r() * size
      ctx.lineWidth = 0.8 + r() * 1.2
      hctx.lineWidth = ctx.lineWidth + 1
      ctx.beginPath(); ctx.moveTo(x, y); hctx.beginPath(); hctx.moveTo(x, y)
      for (let s = 0; s < 6; s++) {
        x += (r() - 0.5) * 46
        y += (r() - 0.5) * 46
        ctx.lineTo(x, y); hctx.lineTo(x, y)
      }
      ctx.stroke(); hctx.stroke()
    }
  }
  if (wear >= 2) {
    // repaved patches: darker, smoother (flat-ish in height) rectangles
    for (let i = 0; i < 3; i++) {
      const px = r() * size
      const py = r() * size
      const w = 40 + r() * 90
      const h = 28 + r() * 60
      ctx.fillStyle = `rgba(18,18,22,${0.16 + r() * 0.12})`
      ctx.fillRect(px, py, w, h)
      hctx.fillStyle = 'rgba(130,130,130,0.7)'
      hctx.fillRect(px, py, w, h)
    }
  }
  return {
    albedo: register(name, 'albedo', c, true),
    normal: register(name + '_n', 'normal', heightToNormal(hc, 1.7), false),
  }
}

// Arcade/Kenney-style asphalt: deliberately clean + flat — a smooth dark grey
// with only faint grain, no visible aggregate or cracks. Pairs with crisp
// (un-worn) markings for a stylized road-kit look, as an A/B against realistic.
function arcadeAsphaltMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('asphalt_arcade')
  ctx.fillStyle = '#42464e'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#8a8a8a'
  hctx.fillRect(0, 0, size, size)
  speckle(ctx, size, r, 1300, 0.03, true)
  speckle(ctx, size, r, 1000, 0.03, false)
  for (let i = 0; i < 8; i++) {
    const g = ctx.createRadialGradient(r() * size, r() * size, 2, r() * size, r() * size, size * (0.1 + r() * 0.18))
    g.addColorStop(0, `rgba(0,0,0,${0.02 + r() * 0.04})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  return {
    albedo: register('asphalt_arcade', 'albedo', c, true),
    normal: register('asphalt_arcade_n', 'normal', heightToNormal(hc, 0.4), false),
  }
}

function cobbleMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  // one tile covers ROAD_TILE_M (6 m): 32 setts per side ≈ 19 cm stones. The
  // previous 8-per-side (75 cm) read as giant pillows at street level.
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('cobble')
  ctx.fillStyle = '#6f6a62'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#404040'
  hctx.fillRect(0, 0, size, size)
  const cell = 16
  for (let y = 0; y < size / cell; y++) {
    for (let x = 0; x < size / cell; x++) {
      const jx = (r() - 0.5) * 2
      const jy = (r() - 0.5) * 2
      const shade = 150 + r() * 60
      ctx.fillStyle = `rgb(${shade},${shade * 0.97},${shade * 0.9})`
      hctx.fillStyle = `rgb(${170 + r() * 60},0,0)`
      const pad = 1.2
      roundRect(ctx, x * cell + pad + jx, y * cell + pad + jy, cell - pad * 2, cell - pad * 2, 3.5)
      roundRect(hctx, x * cell + pad + jx, y * cell + pad + jy, cell - pad * 2, cell - pad * 2, 3.5)
    }
  }
  return {
    albedo: register('cobble_albedo', 'albedo', c, true),
    normal: register('cobble_normal', 'normal', heightToNormal(hc, 1.4), false),
  }
}

function paversMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  // one tile covers ROAD_TILE_M (6 m): 32 rows ≈ 19 cm × 37 cm bricks
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('pavers')
  ctx.fillStyle = '#7d7a72'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#383838'
  hctx.fillRect(0, 0, size, size)
  const rowH = 16
  const brickW = 32
  for (let y = 0; y < size / rowH; y++) {
    const offset = (y % 2) * (brickW / 2)
    for (let x = -1; x < size / brickW + 1; x++) {
      const shade = 165 + r() * 45
      ctx.fillStyle = `rgb(${shade},${shade * 0.98},${shade * 0.93})`
      hctx.fillStyle = `rgb(${180 + r() * 50},0,0)`
      ctx.fillRect(x * brickW + offset + 1, y * rowH + 1, brickW - 2, rowH - 2)
      hctx.fillRect(x * brickW + offset + 1, y * rowH + 1, brickW - 2, rowH - 2)
    }
  }
  return {
    albedo: register('pavers_albedo', 'albedo', c, true),
    normal: register('pavers_normal', 'normal', heightToNormal(hc, 1.2), false),
  }
}

function gravelAlbedo(): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const r = rng('gravel')
  ctx.fillStyle = '#8b8272'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 2600; i++) {
    const shade = 110 + r() * 110
    ctx.fillStyle = `rgb(${shade},${shade * 0.95},${shade * 0.85})`
    const s = 1.5 + r() * 3.5
    ctx.beginPath()
    ctx.arc(r() * size, r() * size, s / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  return register('gravel_albedo', 'albedo', c, true)
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

// Concrete-slab sidewalk: aggregate-fleck concrete with recessed expansion
// joints (a slab grid), subtle staining, and a matching height→normal so the
// joints catch a shadow line. Tiles over SIDEWALK_TILE_M (see library.ts).
function sidewalkMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('sidewalk')
  ctx.fillStyle = '#adaba2'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#b0b0b0'
  hctx.fillRect(0, 0, size, size)
  // slab-to-slab tonal variation (each slab casts slightly differently)
  const cells = 2 // 2×2 slabs per tile
  const cell = size / cells
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const v = (r() - 0.5) * 18
      ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`
      ctx.fillRect(gx * cell, gy * cell, cell, cell)
    }
  }
  // aggregate + fine grit
  speckle(ctx, size, r, 3200, 0.05, false)
  speckle(ctx, size, r, 2000, 0.05, true)
  // soft grime blotches
  for (let i = 0; i < 10; i++) {
    const g = ctx.createRadialGradient(r() * size, r() * size, 2, r() * size, r() * size, size * (0.05 + r() * 0.12))
    g.addColorStop(0, `rgba(40,38,34,${0.06 + r() * 0.08})`)
    g.addColorStop(1, 'rgba(40,38,34,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  // recessed expansion joints (slab grid) — dark in albedo, low in height
  for (let i = 0; i <= cells; i++) {
    const p = i * cell
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth = 3
    hctx.strokeStyle = '#3a3a3a'
    hctx.lineWidth = 4
    for (const [a, b, c2, d] of [[0, p, size, p], [p, 0, p, size]] as const) {
      ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d); ctx.stroke()
      hctx.beginPath(); hctx.moveTo(a, b); hctx.lineTo(c2, d); hctx.stroke()
    }
  }
  return {
    albedo: register('sidewalk_albedo', 'albedo', c, true),
    normal: register('sidewalk_normal', 'normal', heightToNormal(hc, 1.1), false),
  }
}

// ---------------------------------------------------------------------------
// Ground cover — grass / park / forest floor / bare ground / sand.
// A blade-field albedo + height→normal so vegetation reads as vegetation, not
// a flat tinted plane. Tiled in world meters (repeat set in areas.ts).
// ---------------------------------------------------------------------------

interface GrassOpts {
  base: string // soil/thatch fill under the blades
  blade: [number, number, number] // mean blade RGB
  spread: number // tonal spread of the blades
  density: number // blades per tile
  dryness: number // 0..1 dry/dirt fleck amount
}

function grassMaps(name: string, o: GrassOpts): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng(name)
  ctx.fillStyle = o.base
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#787878'
  hctx.fillRect(0, 0, size, size)
  // low-frequency mottling so a large lawn isn't one flat hue
  for (let i = 0; i < 46; i++) {
    const cx = r() * size
    const cy = r() * size
    const rad = size * (0.07 + r() * 0.16)
    const light = (r() - 0.5) * 40
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad)
    const w = light > 0 ? 255 : 0
    g.addColorStop(0, `rgba(${w},${w},${w},${Math.abs(light) / 255})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  // blades: short strokes in varied greens, wrapping across the tile edge
  const [br, bg, bb] = o.blade
  for (let i = 0; i < o.density; i++) {
    const x = r() * size
    const y = r() * size
    const len = 2.5 + r() * 6.5
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.05
    const v = (r() - 0.5) * o.spread
    const ex = x + Math.cos(ang) * len
    const ey = y + Math.sin(ang) * len
    ctx.strokeStyle = `rgb(${clampByte(br + v * 0.5)},${clampByte(bg + v)},${clampByte(bb + v * 0.4)})`
    ctx.lineWidth = 0.7 + r() * 0.9
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke()
    const hv = r() > 0.5 ? 150 + r() * 70 : 60 + r() * 55
    hctx.strokeStyle = `rgb(${hv},${hv},${hv})`
    hctx.lineWidth = ctx.lineWidth
    hctx.beginPath(); hctx.moveTo(x, y); hctx.lineTo(ex, ey); hctx.stroke()
  }
  // dry/dirt flecks
  for (let i = 0; i < o.dryness * 1100; i++) {
    const shade = 120 + r() * 70
    ctx.fillStyle = `rgba(${clampByte(shade)},${clampByte(shade * 0.85)},${clampByte(shade * 0.58)},0.5)`
    const s = 1 + r() * 2
    ctx.fillRect(r() * size, r() * size, s, s)
  }
  return {
    albedo: register(name, 'albedo', c, true),
    normal: register(name + '_n', 'normal', heightToNormal(hc, 1.0), false),
  }
}

function sandMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 512
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('sand')
  ctx.fillStyle = '#cbb98f'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#808080'
  hctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 9000; i++) {
    const shade = 150 + r() * 80
    ctx.fillStyle = `rgba(${clampByte(shade)},${clampByte(shade * 0.9)},${clampByte(shade * 0.68)},0.5)`
    const s = 1 + r() * 2
    const x = r() * size
    const y = r() * size
    ctx.fillRect(x, y, s, s)
    const hv = 90 + r() * 90
    hctx.fillStyle = `rgb(${hv},${hv},${hv})`
    hctx.fillRect(x, y, s, s)
  }
  return {
    albedo: register('sand_albedo', 'albedo', c, true),
    normal: register('sand_normal', 'normal', heightToNormal(hc, 0.8), false),
  }
}

// ---------------------------------------------------------------------------
// Building facades ("trim sheet rows" — one tile per style; atlas-packed at bake)
// ---------------------------------------------------------------------------

interface FacadeStyleOpts {
  bg: string
  glass: string
  windowW: number // fraction of tile
  windowH: number
  frame: string
  bands?: boolean // horizontal glass bands (office)
  mullions?: boolean
  shutters?: boolean
  brick?: boolean
  panels?: boolean
}

function facadeAlbedo(name: string, o: FacadeStyleOpts): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const r = rng(name)
  ctx.fillStyle = o.bg
  ctx.fillRect(0, 0, size, size)

  if (o.brick) {
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'
    ctx.lineWidth = 1.5
    for (let y = 0; y < size; y += 12) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke()
      const off = ((y / 12) % 2) * 16
      for (let x = off; x < size; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 12); ctx.stroke()
      }
    }
    speckle(ctx, size, r, 700, 0.05, false)
  }
  if (o.panels) {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, size - 2, size - 2)
    speckle(ctx, size, r, 500, 0.04, false)
  }
  if (!o.brick && !o.panels && !o.bands) speckle(ctx, size, r, 600, 0.035, false)

  if (o.bands) {
    // continuous ribbon glazing: spandrel + glass band
    const bandTop = size * 0.18
    const bandH = size * 0.55
    ctx.fillStyle = o.glass
    ctx.fillRect(0, bandTop, size, bandH)
    ctx.fillStyle = 'rgba(255,255,255,0.14)'
    ctx.fillRect(0, bandTop, size, 10)
    if (o.mullions) {
      ctx.fillStyle = o.frame
      for (let x = 0; x < size; x += 64) ctx.fillRect(x - 2, bandTop, 4, bandH)
    }
    ctx.fillStyle = o.frame
    ctx.fillRect(0, bandTop - 3, size, 3)
    ctx.fillRect(0, bandTop + bandH, size, 3)
  } else {
    // punched window
    const ww = size * o.windowW
    const wh = size * o.windowH
    const wx = (size - ww) / 2
    const wy = size * 0.16
    ctx.fillStyle = o.glass
    ctx.fillRect(wx, wy, ww, wh)
    ctx.fillStyle = 'rgba(255,255,255,0.16)'
    ctx.fillRect(wx, wy, ww, wh * 0.14)
    ctx.strokeStyle = o.frame
    ctx.lineWidth = 5
    ctx.strokeRect(wx, wy, ww, wh)
    ctx.beginPath()
    ctx.moveTo(wx + ww / 2, wy)
    ctx.lineTo(wx + ww / 2, wy + wh)
    ctx.stroke()
    // sill
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(wx - 6, wy + wh + 3, ww + 12, 5)
    if (o.shutters) {
      ctx.fillStyle = 'rgba(70,90,80,0.85)'
      ctx.fillRect(wx - 22, wy, 16, wh)
      ctx.fillRect(wx + ww + 6, wy, 16, wh)
    }
  }
  return register(name, 'albedo', c, true)
}

function storefrontAlbedo(): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  ctx.fillStyle = '#cbb391'
  ctx.fillRect(0, 0, size, size)
  // large display glass with sign band above
  ctx.fillStyle = '#5b7280'
  ctx.fillRect(14, size * 0.3, size - 28, size * 0.62)
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fillRect(14, size * 0.3, size - 28, 14)
  ctx.fillStyle = '#3d4147'
  ctx.fillRect(10, size * 0.1, size - 20, size * 0.14)
  ctx.strokeStyle = '#2e3236'
  ctx.lineWidth = 5
  ctx.strokeRect(14, size * 0.3, size - 28, size * 0.62)
  return register('facade_storefront', 'albedo', c, true)
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------

function roofAlbedo(name: string, kind: 'bitumen' | 'tile' | 'metal' | 'concrete'): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const r = rng(name)
  if (kind === 'bitumen') {
    ctx.fillStyle = '#4c4844'
    ctx.fillRect(0, 0, size, size)
    speckle(ctx, size, r, 2400, 0.07, true)
    speckle(ctx, size, r, 1200, 0.09, false)
  } else if (kind === 'tile') {
    ctx.fillStyle = '#9c5540'
    ctx.fillRect(0, 0, size, size)
    for (let y = 0; y < size; y += 20) {
      ctx.fillStyle = `rgba(0,0,0,0.22)`
      ctx.fillRect(0, y + 16, size, 4)
      for (let x = 0; x < size; x += 26) {
        ctx.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.05})`
        ctx.fillRect(x + ((y / 20) % 2) * 13, y, 24, 16)
      }
    }
  } else if (kind === 'metal') {
    ctx.fillStyle = '#b9bcba'
    ctx.fillRect(0, 0, size, size)
    for (let x = 0; x < size; x += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.fillRect(x, 0, 3, size)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(x + 3, 0, 2, size)
    }
  } else {
    ctx.fillStyle = '#adaaa2'
    ctx.fillRect(0, 0, size, size)
    speckle(ctx, size, r, 1400, 0.05, false)
  }
  return register(name, 'albedo', c, true)
}

// ---------------------------------------------------------------------------
// Decals-as-content (cracks, stains, patches, manholes)
// ---------------------------------------------------------------------------

function decalTexture(name: string, draw: (ctx: CanvasRenderingContext2D, size: number, r: () => number) => void): THREE.Texture {
  const size = 128
  const [c, ctx] = makeCanvas(size)
  ctx.clearRect(0, 0, size, size)
  draw(ctx, size, rng(name))
  const tex = register(name, 'decal-albedo', c, true)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

export function makeDecals() {
  return {
    crack: decalTexture('decal_crack', (ctx, size, r) => {
      ctx.strokeStyle = 'rgba(15,15,15,0.75)'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      let x = size * 0.1
      let y = size * (0.3 + r() * 0.4)
      ctx.moveTo(x, y)
      while (x < size * 0.9) {
        x += 8 + r() * 14
        y += (r() - 0.5) * 26
        ctx.lineTo(x, y)
        if (r() > 0.72) {
          ctx.moveTo(x, y)
          ctx.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30)
          ctx.moveTo(x, y)
        }
      }
      ctx.stroke()
    }),
    stain: decalTexture('decal_stain', (ctx, size, r) => {
      for (let i = 0; i < 7; i++) {
        const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size * (0.2 + r() * 0.28))
        g.addColorStop(0, `rgba(20,18,14,${0.28 + r() * 0.2})`)
        g.addColorStop(1, 'rgba(20,18,14,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(size / 2 + (r() - 0.5) * 26, size / 2 + (r() - 0.5) * 26, size * (0.2 + r() * 0.3), 0, Math.PI * 2)
        ctx.fill()
      }
    }),
    patch: decalTexture('decal_patch', (ctx, size, r) => {
      ctx.fillStyle = 'rgba(28,28,30,0.85)'
      roundRect(ctx, size * 0.12, size * (0.2 + r() * 0.15), size * 0.76, size * 0.5, 8)
    }),
    manhole: decalTexture('decal_manhole', (ctx, size) => {
      ctx.fillStyle = 'rgba(45,45,48,0.95)'
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(120,120,125,0.8)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 2
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath()
        ctx.moveTo(size / 2 + i * 12, size * 0.2)
        ctx.lineTo(size / 2 + i * 12, size * 0.8)
        ctx.stroke()
      }
    }),
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

// ---------------------------------------------------------------------------
// Assembled generation entry points (called once, results cached by library.ts)
// ---------------------------------------------------------------------------

export function generateSurfaceTextures() {
  return {
    asphaltNew: { ...asphaltMaps('asphalt_new', '#43474e', 0), mr: mrTexture('asphalt_new_mr', 0.92, 0.14, 0, 'an') },
    asphaltWorn: { ...asphaltMaps('asphalt_worn', '#4c4f55', 1), mr: mrTexture('asphalt_worn_mr', 0.95, 0.12, 0, 'aw') },
    asphaltPatched: { ...asphaltMaps('asphalt_patched', '#494c52', 2), mr: mrTexture('asphalt_patched_mr', 0.95, 0.14, 0, 'ap') },
    cobble: { ...cobbleMaps(), mr: mrTexture('cobble_mr', 0.85, 0.12, 0, 'cb') },
    pavers: { ...paversMaps(), mr: mrTexture('pavers_mr', 0.88, 0.1, 0, 'pv') },
    gravel: { albedo: gravelAlbedo(), mr: mrTexture('gravel_mr', 0.98, 0.04, 0, 'gv') },
    sidewalk: { ...sidewalkMaps(), mr: mrTexture('sidewalk_mr', 0.93, 0.08, 0, 'sw') },
    asphaltArcade: { ...arcadeAsphaltMaps(), mr: mrTexture('asphalt_arcade_mr', 0.82, 0.05, 0, 'aa') },
  }
}

// Ground-cover materials (grass, park, forest floor, bare ground, sand). Built
// lazily by areas.ts on the first render so node tests that import areas.ts
// (no DOM) never touch a canvas.
export function generateLandTextures() {
  return {
    grass: grassMaps('grass', { base: '#4f6240', blade: [104, 132, 74], spread: 70, density: 9000, dryness: 0.35 }),
    park: grassMaps('park', { base: '#465a3a', blade: [90, 122, 66], spread: 62, density: 10500, dryness: 0.18 }),
    forest: grassMaps('forest', { base: '#3a4a34', blade: [74, 100, 58], spread: 54, density: 8000, dryness: 0.5 }),
    ground: grassMaps('ground', { base: '#525a44', blade: [96, 116, 74], spread: 66, density: 6000, dryness: 0.6 }),
    sand: sandMaps(),
  }
}

export function generateFacadeTextures() {
  return {
    'brick-red': facadeAlbedo('facade_brick_red', { bg: '#c8c0b4', glass: '#5d6c78', windowW: 0.5, windowH: 0.55, frame: '#d8d2c6', brick: true }),
    'brick-brown': facadeAlbedo('facade_brick_brown', { bg: '#c4bcae', glass: '#5a6874', windowW: 0.48, windowH: 0.52, frame: '#cfc8ba', brick: true }),
    'stucco-warm': facadeAlbedo('facade_stucco_warm', { bg: '#d8d2c2', glass: '#607080', windowW: 0.44, windowH: 0.58, frame: '#e8e2d2', shutters: true }),
    'stucco-cool': facadeAlbedo('facade_stucco_cool', { bg: '#d4d6d0', glass: '#5c6c7a', windowW: 0.46, windowH: 0.55, frame: '#e4e6e0' }),
    'concrete-panel': facadeAlbedo('facade_concrete', { bg: '#c2c2bd', glass: '#57646e', windowW: 0.6, windowH: 0.5, frame: '#54565a', panels: true }),
    'office-glass': facadeAlbedo('facade_office', { bg: '#d6d9dc', glass: '#a4b4bf', windowW: 0, windowH: 0, frame: '#aeb2b6', bands: true, mullions: true }),
    'curtainwall-dark': facadeAlbedo('facade_curtainwall', { bg: '#99a1a8', glass: '#76858f', windowW: 0, windowH: 0, frame: '#5a6167', bands: true, mullions: true }),
    'storefront-mixed': storefrontAlbedo(),
  }
}

export function generateRoofTextures() {
  return {
    'bitumen-dark': roofAlbedo('roof_bitumen', 'bitumen'),
    'tile-red': roofAlbedo('roof_tile', 'tile'),
    'metal-pale': roofAlbedo('roof_metal', 'metal'),
    'concrete-pale': roofAlbedo('roof_concrete', 'concrete'),
  }
}
