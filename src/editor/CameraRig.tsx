import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'
import { useEditor } from '../state/store'
import { useDriveHud } from '../state/driveHud'
import { drivableRoads, frameBus } from './bus'

// ---- global key state (shared by fly + drive) ----
const pressed = new Set<string>()
function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!isTyping(e)) pressed.add(e.code)
  })
  window.addEventListener('keyup', (e) => pressed.delete(e.code))
  window.addEventListener('blur', () => pressed.clear())
}

function nearestRoadPoint(x: number, z: number) {
  let best = { d: Infinity, x: 0, z: 0, hx: 0, hz: 1 }
  for (const r of drivableRoads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const abx = b.x - a.x
      const abz = b.z - a.z
      const len2 = abx * abx + abz * abz || 1
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2
      t = Math.max(0, Math.min(1, t))
      const px = a.x + abx * t
      const pz = a.z + abz * t
      const d = (x - px) * (x - px) + (z - pz) * (z - pz)
      if (d < best.d) {
        const l = Math.sqrt(len2)
        best = { d, x: px, z: pz, hx: abx / l, hz: abz / l }
      }
    }
  }
  return best
}

export function CameraRig() {
  const mode = useEditor((s) => s.cameraMode)
  const gizmoDragging = useEditor((s) => s.gizmoDragging)
  const { camera, gl } = useThree()
  const controls = useRef<any>(null)
  const look = useRef({ yaw: 0, pitch: -0.4, active: false })
  const car = useRef({ x: 0, z: 0, hx: 0, hz: 1, speed: 0 })
  const prevMode = useRef<string>('orbit')

  // pointer-drag look for fly mode
  useEffect(() => {
    const el = gl.domElement
    const down = (e: PointerEvent) => {
      if (useEditor.getState().cameraMode !== 'fly') return
      look.current.active = true
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!look.current.active) return
      look.current.yaw -= e.movementX * 0.0032
      look.current.pitch = Math.max(
        -1.4,
        Math.min(1.4, look.current.pitch - e.movementY * 0.0032),
      )
    }
    const up = () => (look.current.active = false)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
  }, [gl])

  // mode transitions
  useEffect(() => {
    if (mode === 'fly' && prevMode.current !== 'fly') {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      look.current.yaw = e.y
      look.current.pitch = e.x
    }
    if (mode === 'drive' && prevMode.current !== 'drive') {
      const target = controls.current?.target ?? new THREE.Vector3()
      const spawn = nearestRoadPoint(target.x, target.z)
      car.current = { x: spawn.x, z: spawn.z, hx: spawn.hx, hz: spawn.hz, speed: 0 }
    }
    if (mode !== 'drive') useDriveHud.getState().setSpeed(0)
    prevMode.current = mode
  }, [mode, camera])

  // camera framing requests (F key / hierarchy double-click)
  useEffect(
    () =>
      frameBus.on(({ center, radius }) => {
        if (useEditor.getState().cameraMode !== 'orbit') useEditor.getState().setCameraMode('orbit')
        const dist = Math.max(radius * 2.4, 30)
        const dir = new THREE.Vector3().subVectors(camera.position, center).normalize()
        if (dir.lengthSq() < 0.01 || dir.y < 0.1) dir.set(0.5, 0.7, 0.5).normalize()
        camera.position.copy(center).addScaledVector(dir, dist)
        if (controls.current) {
          controls.current.target.copy(center)
          controls.current.update()
        }
      }),
    [camera],
  )

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    if (mode === 'fly') {
      camera.rotation.order = 'YXZ'
      camera.rotation.set(look.current.pitch, look.current.yaw, 0)
      const speed = pressed.has('ShiftLeft') || pressed.has('ShiftRight') ? 120 : 35
      const fwd = new THREE.Vector3()
      camera.getWorldDirection(fwd)
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize()
      const v = new THREE.Vector3()
      if (pressed.has('KeyW')) v.add(fwd)
      if (pressed.has('KeyS')) v.sub(fwd)
      if (pressed.has('KeyD')) v.add(right)
      if (pressed.has('KeyA')) v.sub(right)
      if (pressed.has('KeyE')) v.y += 1
      if (pressed.has('KeyQ')) v.y -= 1
      if (v.lengthSq() > 0) {
        v.normalize().multiplyScalar(speed * dt)
        camera.position.add(v)
        camera.position.y = Math.max(camera.position.y, 1.2)
      }
    } else if (mode === 'drive') {
      const c = car.current
      const accel = pressed.has('KeyW') || pressed.has('ArrowUp') ? 9 : 0
      const brake = pressed.has('KeyS') || pressed.has('ArrowDown') ? 14 : 0
      c.speed += (accel - brake * Math.sign(c.speed || 1)) * dt
      // drag + rolling resistance
      c.speed -= c.speed * 0.35 * dt
      c.speed = Math.max(-8, Math.min(26, c.speed))
      if (Math.abs(c.speed) < 0.05 && !accel && !brake) c.speed = 0

      let steer = 0
      if (pressed.has('KeyA') || pressed.has('ArrowLeft')) steer += 1
      if (pressed.has('KeyD') || pressed.has('ArrowRight')) steer -= 1
      if (steer !== 0 && Math.abs(c.speed) > 0.2) {
        const steerRate = steer * 1.9 * dt * Math.sign(c.speed)
        const damp = 1 / (1 + Math.abs(c.speed) * 0.045)
        const a = steerRate * damp * Math.min(Math.abs(c.speed) / 4, 1)
        const nhx = c.hx * Math.cos(a) - c.hz * Math.sin(a)
        const nhz = c.hx * Math.sin(a) + c.hz * Math.cos(a)
        c.hx = nhx
        c.hz = nhz
      }
      c.x += c.hx * c.speed * dt
      c.z += c.hz * c.speed * dt
      camera.position.set(c.x, 1.5, c.z)
      camera.lookAt(c.x + c.hx * 10, 1.35, c.z + c.hz * 10)
      useDriveHud.getState().setSpeed(Math.round(Math.abs(c.speed) * 3.6))
    }
  })

  return (
    <MapControls
      ref={controls}
      enabled={mode === 'orbit' && !gizmoDragging}
      makeDefault
      maxPolarAngle={Math.PI * 0.49}
      minDistance={8}
      maxDistance={2500}
    />
  )
}
