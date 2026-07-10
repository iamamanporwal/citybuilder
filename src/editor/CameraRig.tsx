import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'
import { useEditor } from '../state/store'
import { frameBus, lastOrbitTarget } from './bus'
import { pressed } from './input'

// Drive mode is a real physics sim now — see editor/driving/DriveSim.tsx.
// This rig owns orbit + fly only and publishes the orbit target so the drive
// sim can spawn the car where the user was looking.

export function CameraRig() {
  const mode = useEditor((s) => s.cameraMode)
  const gizmoDragging = useEditor((s) => s.gizmoDragging)
  const { camera, gl } = useThree()
  const controls = useRef<any>(null)
  const look = useRef({ yaw: 0, pitch: -0.4, active: false })
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
