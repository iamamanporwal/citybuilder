import * as THREE from 'three'
import type { PointFeature, RoadSegment, Vec2 } from '../types'
import type { ResolvedContext } from '../resolver/types'
import { mats } from './materials'
import { NON_DRIVABLE } from './roadNetwork'
import { pointAlong, polylineLength } from './geometry'
import { deviceHeading, displaySpeed, effectiveSpeed, speedUnitFor } from './signMath'
import { buildRoadElevation } from './corridor'
import { CarriagewayIndex } from './props'

// FAITHFUL traffic signs (Road-updates.md §8.1). Procedural pole + plate; the
// plate face is a region-keyed canvas texture drawn to the actual sign class
// (stop / give-way / speed limit) so a learner reads a correct sign. Cheap,
// many-instance geometry — never a generated mesh. Canvas usage is lazy + cached,
// so importing this module is DOM-free until a sign is actually built.

// ---- sign-face canvas textures (lazy + cached) ----------------------------

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return [c, c.getContext('2d')!]
}
function texFrom(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

let _stop: THREE.Texture | null = null
function stopFace(): THREE.Texture {
  if (_stop) return _stop
  const [c, ctx] = canvas(256)
  ctx.clearRect(0, 0, 256, 256)
  // red octagon
  ctx.beginPath()
  const r = 122
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 8) * (2 * i + 1) // flat top
    const x = 128 + r * Math.cos(a)
    const y = 128 + r * Math.sin(a)
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = '#b71c1c'
  ctx.fill()
  ctx.lineWidth = 10
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 74px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('STOP', 128, 132)
  return (_stop = texFrom(c))
}

let _yield: THREE.Texture | null = null
function yieldFace(): THREE.Texture {
  if (_yield) return _yield
  const [c, ctx] = canvas(256)
  ctx.clearRect(0, 0, 256, 256)
  // downward triangle, white with red border
  ctx.beginPath()
  ctx.moveTo(20, 40)
  ctx.lineTo(236, 40)
  ctx.lineTo(128, 226)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.lineWidth = 20
  ctx.strokeStyle = '#b71c1c'
  ctx.stroke()
  return (_yield = texFrom(c))
}

const _speed = new Map<string, THREE.Texture>()
/** Speed-limit face: MUTCD white rectangle (us-rect) or red-ring circle (eu/jp). */
function speedFace(display: number, unit: 'mph' | 'km/h', style: 'us-rect' | 'circle'): THREE.Texture {
  const key = `${style}:${display}:${unit}`
  const hit = _speed.get(key)
  if (hit) return hit
  const [c, ctx] = canvas(256)
  ctx.clearRect(0, 0, 256, 256)
  if (style === 'us-rect') {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#111111'
    ctx.lineWidth = 10
    roundRect(ctx, 40, 8, 176, 240, 14)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#111111'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 34px sans-serif'
    ctx.fillText('SPEED', 128, 60)
    ctx.fillText('LIMIT', 128, 100)
    ctx.font = 'bold 96px sans-serif'
    ctx.fillText(String(display), 128, 180)
  } else {
    ctx.beginPath()
    ctx.arc(128, 128, 118, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.lineWidth = 26
    ctx.strokeStyle = '#b71c1c'
    ctx.stroke()
    ctx.fillStyle = '#111111'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 108px sans-serif'
    ctx.fillText(String(display), 128, 138)
  }
  const t = texFrom(c)
  _speed.set(key, t)
  return t
}

let _generic: THREE.Texture | null = null
function genericFace(): THREE.Texture {
  if (_generic) return _generic
  const [c, ctx] = canvas(256)
  ctx.clearRect(0, 0, 256, 256)
  // yellow warning diamond (the most common unmapped traffic_sign is a warning)
  ctx.save()
  ctx.translate(128, 128)
  ctx.rotate(Math.PI / 4)
  ctx.fillStyle = '#f5c518'
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 10
  roundRect(ctx, -86, -86, 172, 172, 14)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
  return (_generic = texFrom(c))
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ---- geometry -------------------------------------------------------------

/** Pole + a flat plate carrying `face`, front on local +Z, ready for a Y-rotation. */
function signPost(face: THREE.Texture, w: number, h: number): THREE.Group {
  const g = new THREE.Group()
  const poleH = 2.1
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, poleH + h, 8), mats.signalPole)
  pole.position.y = (poleH + h) / 2
  pole.castShadow = true
  g.add(pole)
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: face, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.1 }),
  )
  plate.position.set(0, poleH + h / 2, 0.045)
  plate.castShadow = true
  g.add(plate)
  return g
}

export function buildStopSign(p: PointFeature): THREE.Group {
  const g = signPost(stopFace(), 0.75, 0.75)
  g.name = p.name ?? 'Stop sign'
  return g
}

export function buildGiveWaySign(p: PointFeature): THREE.Group {
  const g = signPost(yieldFace(), 0.9, 0.78)
  g.name = p.name ?? 'Give way'
  return g
}

export function buildGenericSign(p: PointFeature): THREE.Group {
  const g = signPost(genericFace(), 0.62, 0.62)
  g.name = p.name ?? (p.signType ? `Sign (${p.signType})` : 'Road sign')
  return g
}

export function buildSpeedLimitSign(display: number, unit: 'mph' | 'km/h', style: 'us-rect' | 'circle'): THREE.Group {
  const dims: [number, number] = style === 'us-rect' ? [0.6, 0.8] : [0.7, 0.7]
  const g = signPost(speedFace(display, unit, style), dims[0], dims[1])
  g.name = `Speed limit ${display} ${unit}`
  return g
}

// ---- speed-limit sign placement (from road maxspeed, faithful only) -------

export interface SpeedSignPlacement {
  id: string
  roadId: string
  position: Vec2
  /** Road-surface elevation at the sign (0 = grade). */
  y: number
  headingY: number
  display: number
  unit: 'mph' | 'km/h'
  style: 'us-rect' | 'circle'
  kmh: number
  lat: number
  lng: number
}

/**
 * One speed-limit sign per drivable road that carries a real OSM maxspeed
 * (source==='tag' — never invented), on the driving side near the road entry,
 * facing oncoming traffic. Region sets the plate style + unit. Deterministic.
 */
export function planSpeedLimitSigns(roads: RoadSegment[], ctx: ResolvedContext): SpeedSignPlacement[] {
  const out: SpeedSignPlacement[] = []
  const style: 'us-rect' | 'circle' = ctx.region.signShape === 'us-rect' ? 'us-rect' : 'circle'
  const unit = speedUnitFor(ctx.region.id)
  const sideSign = ctx.region.drivingSide === 'left' ? 1 : -1 // left-normal for LHT, right for RHT
  const elevation = buildRoadElevation(roads)
  const index = new CarriagewayIndex(roads)
  for (const r of roads) {
    if (NON_DRIVABLE.has(r.roadClass) || r.tunnel || r.points.length < 2) continue
    const eff = effectiveSpeed(r, ctx.region.id)
    if (!eff || eff.source !== 'tag') continue // faithful: physical signs only from tagged data
    const L = polylineLength(r.points)
    if (L < 20) continue
    const s = Math.min(15, L * 0.25)
    const { p, dir } = pointAlong(r.points, s)
    const leftN = { x: dir.z, z: -dir.x }
    const off = r.widthM / 2 + 1.2
    const position = { x: p.x + leftN.x * sideSign * off, z: p.z + leftN.z * sideSign * off }
    if (index.insideCarriageway(position, 0.3)) continue // would stand in a parallel carriageway
    const e = elevation.profileFor(r, [s])[0] ?? 0
    out.push({
      id: `speedsign_${r.id}`,
      roadId: r.id,
      position,
      y: Math.abs(e) > 1e-6 ? e : 0,
      headingY: deviceHeading({ dir, oneway: r.oneway, dist: 0 }, true), // face oncoming
      display: displaySpeed(eff.kmh, unit),
      unit,
      style,
      kmh: eff.kmh,
      lat: r.centerLat,
      lng: r.centerLng,
    })
  }
  return out
}
