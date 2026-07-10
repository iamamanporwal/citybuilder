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

function asphaltAlbedo(name: string, base: string, wear: number): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const r = rng(name)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  speckle(ctx, size, r, 2200, 0.08, true)
  speckle(ctx, size, r, 1600, 0.1, false)
  if (wear >= 1) {
    // faded wheel-path banding + fine cracks
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    ctx.fillRect(0, size * 0.18, size, size * 0.16)
    ctx.fillRect(0, size * 0.66, size, size * 0.16)
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1
    for (let i = 0; i < 4 + wear * 3; i++) {
      ctx.beginPath()
      let x = r() * size
      let y = r() * size
      ctx.moveTo(x, y)
      for (let s = 0; s < 6; s++) {
        x += (r() - 0.5) * 40
        y += r() * 26
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }
  if (wear >= 2) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.1})`
      const w = 30 + r() * 70
      const h = 20 + r() * 50
      ctx.fillRect(r() * size, r() * size, w, h)
    }
  }
  return register(name, 'albedo', c, true)
}

function cobbleMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('cobble')
  ctx.fillStyle = '#6f6a62'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#404040'
  hctx.fillRect(0, 0, size, size)
  const cell = 32
  for (let y = 0; y < size / cell; y++) {
    for (let x = 0; x < size / cell; x++) {
      const jx = (r() - 0.5) * 4
      const jy = (r() - 0.5) * 4
      const shade = 150 + r() * 60
      ctx.fillStyle = `rgb(${shade},${shade * 0.97},${shade * 0.9})`
      hctx.fillStyle = `rgb(${170 + r() * 60},0,0)`
      const pad = 2.5
      roundRect(ctx, x * cell + pad + jx, y * cell + pad + jy, cell - pad * 2, cell - pad * 2, 7)
      roundRect(hctx, x * cell + pad + jx, y * cell + pad + jy, cell - pad * 2, cell - pad * 2, 7)
    }
  }
  return {
    albedo: register('cobble_albedo', 'albedo', c, true),
    normal: register('cobble_normal', 'normal', heightToNormal(hc, 2.2), false),
  }
}

function paversMaps(): { albedo: THREE.Texture; normal: THREE.Texture } {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const [hc, hctx] = makeCanvas(size)
  const r = rng('pavers')
  ctx.fillStyle = '#7d7a72'
  ctx.fillRect(0, 0, size, size)
  hctx.fillStyle = '#383838'
  hctx.fillRect(0, 0, size, size)
  const rowH = 32
  for (let y = 0; y < size / rowH; y++) {
    const offset = (y % 2) * 32
    for (let x = -1; x < size / 64 + 1; x++) {
      const shade = 165 + r() * 45
      ctx.fillStyle = `rgb(${shade},${shade * 0.98},${shade * 0.93})`
      hctx.fillStyle = `rgb(${180 + r() * 50},0,0)`
      ctx.fillRect(x * 64 + offset + 1.5, y * rowH + 1.5, 61, rowH - 3)
      hctx.fillRect(x * 64 + offset + 1.5, y * rowH + 1.5, 61, rowH - 3)
    }
  }
  return {
    albedo: register('pavers_albedo', 'albedo', c, true),
    normal: register('pavers_normal', 'normal', heightToNormal(hc, 1.8), false),
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

function sidewalkAlbedo(): THREE.Texture {
  const size = 256
  const [c, ctx] = makeCanvas(size)
  const r = rng('sidewalk')
  ctx.fillStyle = '#a7a59d'
  ctx.fillRect(0, 0, size, size)
  speckle(ctx, size, r, 1500, 0.06, false)
  speckle(ctx, size, r, 900, 0.06, true)
  ctx.strokeStyle = 'rgba(0,0,0,0.28)'
  ctx.lineWidth = 2
  for (let i = 0; i <= 2; i++) {
    ctx.beginPath()
    ctx.moveTo(0, i * 128)
    ctx.lineTo(size, i * 128)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(i * 128, 0)
    ctx.lineTo(i * 128, size)
    ctx.stroke()
  }
  return register('sidewalk_albedo', 'albedo', c, true)
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
    asphaltNew: { albedo: asphaltAlbedo('asphalt_new', '#4a4e55', 0), mr: mrTexture('asphalt_new_mr', 0.92, 0.1, 0, 'an') },
    asphaltWorn: { albedo: asphaltAlbedo('asphalt_worn', '#53565c', 1), mr: mrTexture('asphalt_worn_mr', 0.95, 0.08, 0, 'aw') },
    asphaltPatched: { albedo: asphaltAlbedo('asphalt_patched', '#505359', 2), mr: mrTexture('asphalt_patched_mr', 0.95, 0.1, 0, 'ap') },
    cobble: { ...cobbleMaps(), mr: mrTexture('cobble_mr', 0.85, 0.12, 0, 'cb') },
    pavers: { ...paversMaps(), mr: mrTexture('pavers_mr', 0.88, 0.1, 0, 'pv') },
    gravel: { albedo: gravelAlbedo(), mr: mrTexture('gravel_mr', 0.98, 0.04, 0, 'gv') },
    sidewalk: { albedo: sidewalkAlbedo(), mr: mrTexture('sidewalk_mr', 0.93, 0.08, 0, 'sw') },
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
