import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'
import { useEditor } from '../state/store'
import { clearFocus, focusState, focusTarget, frameBus, lastOrbitTarget, setFocus } from './bus'
import { getVariant } from '../scene/registry'
import { pressed } from './input'

const PROC_FALLBACK = { state: 'procedural', provider: 'procedural', license: '', approved: true } as const

// Drive mode is a real physics sim now — see editor/driving/DriveSim.tsx.
// This rig owns orbit + fly only and publishes the orbit target so the drive
// sim can spawn the car where the user was looking.

export function CameraRig() {
  const mode = useEditor((s) => s.cameraMode)
  const gizmoDragging = useEditor((s) => s.gizmoDragging)
  const selection = useEditor((s) => s.selection)
  const order = useEditor((s) => s.objectOrder)
  const { camera, gl } = useThree()
  const controls = useRef<any>(null)
  const look = useRef({ yaw: 0, pitch: -0.4, active: false })
  const prevMode = useRef<string>('orbit')

  // A new scene invalidates any prior focus point.
  useEffect(() => clearFocus(), [order])

  // Track the selected object's centre as the persisted focus, so every camera
  // mode can re-acquire it on entry (fixes "changing mode loses the building").
  useEffect(() => {
    if (!selection.length) { clearFocus(); return } // deselect/delete drops the focus point
    const box = new THREE.Box3()
    let has = false
    for (const id of selection) {
      const obj = useEditor.getState().objects[id]
      if (!obj) continue
      const three = getVariant(obj.id, obj.asset) ?? getVariant(obj.id, PROC_FALLBACK)
      if (three && three.parent) { three.updateMatrixWorld(true); box.expandByObject(three); has = true }
    }
    if (has && !box.isEmpty()) setFocus(box.getCenter(new THREE.Vector3()))
  }, [selection])

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

  // mode transitions — re-seed the newly active controller from the shared focus
  // so the view never jumps to a stale pivot or loses the focused object.
  useEffect(() => {
    if (mode === 'fly' && prevMode.current !== 'fly') {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      look.current.yaw = e.y
      look.current.pitch = e.x
    }
    if (mode === 'orbit' && prevMode.current !== 'orbit' && controls.current) {
      // Entering orbit: the controls' target is stale (fly/drive moved the
      // camera directly). Re-seed it to the focused object — or, absent a
      // focus, a point straight ahead — so the first damped update() doesn't
      // whip the view around the old pivot.
      const target = new THREE.Vector3()
      if (focusState.has) {
        target.copy(focusTarget)
      } else {
        const fwd = new THREE.Vector3()
        camera.getWorldDirection(fwd)
        target.copy(camera.position).addScaledVector(fwd, 120)
        target.y = Math.max(target.y, 0)
      }
      controls.current.target.copy(target)
      controls.current.update()
    }
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
    if (controls.current?.target) lastOrbitTarget.copy(controls.current.target)
    if (mode === 'fly') {
      camera.rotation.order = 'YXZ'
      camera.rotation.set(look.current.pitch, look.current.yaw, 0)
      const speed = pressed.has('ShiftLeft') || pressed.has('ShiftRight') ? 160 : 55
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
    }
  })

  return (
    <MapControls
      ref={controls}
      enabled={mode === 'orbit' && !gizmoDragging}
      makeDefault
      // Mac-friendly, design-tool convention: left-drag orbits, right-drag pans,
      // scroll / two-finger pinch zooms (to cursor). Smooth damping throughout.
      enableDamping
      dampingFactor={0.12}
      zoomToCursor
      rotateSpeed={0.6}
      panSpeed={0.9}
      zoomSpeed={0.9}
      screenSpacePanning={false}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
      touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      maxPolarAngle={Math.PI * 0.49}
      minDistance={8}
      maxDistance={4000}
    />
  )
}
