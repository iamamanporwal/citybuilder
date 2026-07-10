import * as THREE from 'three'

// Shared materials + procedural facade textures. Textures are grayscale-ish so
// per-building material.color tints them.

function makeFacadeTexture(lit: boolean): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')!
  // wall
  ctx.fillStyle = '#d8d8d8'
  ctx.fillRect(0, 0, 128, 128)
  // subtle floor line
  ctx.fillStyle = '#c8c8c8'
  ctx.fillRect(0, 124, 128, 4)
  // window: one cell = one texture tile (repeat set in UV space)
  const wx = 26
  const wy = 22
  const ww = 76
  const wh = 74
  ctx.fillStyle = lit ? '#a8c0ce' : '#70828f'
  ctx.fillRect(wx, wy, ww, wh)
  // frame + glass shading
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.fillRect(wx, wy, ww, 8)
  ctx.strokeStyle = '#b0b0b0'
  ctx.lineWidth = 4
  ctx.strokeRect(wx, wy, ww, wh)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export const facadeTexture = makeFacadeTexture(false)
export const facadeTextureEnhanced = makeFacadeTexture(true)

export const mats = {
  // (terrain/ground material lives in procgen/areas.ts, which stays canvas-free for headless tests)
  roadAsphalt: new THREE.MeshStandardMaterial({ color: '#4a4e55', roughness: 0.95 }),
  roadService: new THREE.MeshStandardMaterial({ color: '#565a61', roughness: 0.95 }),
  pedestrian: new THREE.MeshStandardMaterial({ color: '#8a8078', roughness: 1 }),
  sidewalk: new THREE.MeshStandardMaterial({ color: '#9a9a94', roughness: 1 }),
  curb: new THREE.MeshStandardMaterial({ color: '#7d7d78', roughness: 0.9 }),
  markingWhite: new THREE.MeshBasicMaterial({ color: '#e8e8e0' }),
  markingYellow: new THREE.MeshBasicMaterial({ color: '#d8b93a' }),
  roofDark: new THREE.MeshStandardMaterial({ color: '#4a4640', roughness: 0.95 }),
  roofEnhanced: new THREE.MeshStandardMaterial({ color: '#5a564e', roughness: 0.85 }),
  treeTrunk: new THREE.MeshStandardMaterial({ color: '#5d4a32', roughness: 1 }),
  treeCanopy: new THREE.MeshStandardMaterial({ color: '#4d7038', roughness: 1 }),
  signalPole: new THREE.MeshStandardMaterial({ color: '#2e3238', roughness: 0.6, metalness: 0.6 }),
  signalHead: new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.7 }),
  signalRed: new THREE.MeshBasicMaterial({ color: '#e04434' }),
  signalAmber: new THREE.MeshBasicMaterial({ color: '#e0a020' }),
  signalGreen: new THREE.MeshBasicMaterial({ color: '#38c060' }),
}

// palette of wall tints for generic buildings (applied over facade texture)
const WALL_TINTS = [
  '#c9bda9',
  '#bfb6ad',
  '#b5a89a',
  '#c4b8b0',
  '#a89e94',
  '#cfc6b8',
  '#b8ab9d',
  '#9f9891',
  '#c2b4a2',
  '#ada598',
]

export function wallMaterialFor(seed: number, enhanced = false): THREE.MeshStandardMaterial {
  const color = WALL_TINTS[Math.floor(seed * WALL_TINTS.length) % WALL_TINTS.length]
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: enhanced ? 0.75 : 0.9,
    map: enhanced ? facadeTextureEnhanced : facadeTexture,
  })
  // one window tile per ~4m x 3.4m of facade (UVs are in world meters)
  m.map = (enhanced ? facadeTextureEnhanced : facadeTexture).clone()
  m.map.repeat.set(1 / 4, 1 / 3.4)
  m.map.needsUpdate = true
  return m
}
