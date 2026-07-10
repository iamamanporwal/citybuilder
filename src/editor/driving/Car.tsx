import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { CuboidCollider, RigidBody, useBeforePhysicsStep, useRapier, type RapierRigidBody } from '@react-three/rapier'
import type { DynamicRayCastVehicleController } from '@dimforge/rapier3d-compat'
import { lastOrbitTarget, nearestRoadPoint } from '../bus'
import { pressed } from '../input'
import { useDriveHud } from '../../state/driveHud'

// Physics car for the drive preview: dynamic cuboid chassis + Rapier's
// DynamicRayCastVehicleController (raycast wheels — no wheel colliders or
// joints to tune). Rear-wheel drive, speed-sensitive steering, chase camera.

const CHASSIS_HALF: [number, number, number] = [0.9, 0.55, 2.2]
const WHEEL_RADIUS = 0.35
const SUSPENSION_REST = 0.35
// wheel connection points in chassis-local space (front pair first)
const WHEELS: [number, number, number][] = [
  [-0.85, -0.3, 1.5],
  [0.85, -0.3, 1.5],
  [-0.85, -0.3, -1.5],
  [0.85, -0.3, -1.5],
]
const FRONT = [0, 1]
const REAR = [2, 3]
const ENGINE_FORCE = 4500 // per rear wheel
const BRAKE_FORCE = 3500 // per wheel
const REVERSE_FORCE = 2500
const MAX_STEER = 0.55 // rad, tapered with speed

export function Car() {
  const { world } = useRapier()
  const { camera } = useThree()
  const chassis = useRef<RapierRigidBody>(null)
  const vc = useRef<DynamicRayCastVehicleController | null>(null)

  const spawn = useMemo(() => {
    const s = nearestRoadPoint(lastOrbitTarget.x, lastOrbitTarget.z)
    return { x: s.x, z: s.z, yaw: Math.atan2(s.hx, s.hz) } // local +z is forward
  }, [])

  useEffect(() => {
    const body = chassis.current
    if (!body) return
    const controller = world.createVehicleController(body)
    controller.indexUpAxis = 1
    controller.setIndexForwardAxis = 2
    for (const [x, y, z] of WHEELS) {
      controller.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST, WHEEL_RADIUS)
    }
    for (let i = 0; i < WHEELS.length; i++) {
      controller.setWheelSuspensionStiffness(i, 24)
      controller.setWheelFrictionSlip(i, 1.8)
      controller.setWheelMaxSuspensionForce(i, 24000)
    }
    vc.current = controller
    return () => {
      if (vc.current) world.removeVehicleController(vc.current)
      vc.current = null
      useDriveHud.getState().setSpeed(0)
    }
  }, [world])

  useBeforePhysicsStep((w) => {
    const controller = vc.current
    const body = chassis.current
    if (!controller || !body) return

    // kill-plane: fell off the world (e.g. through a water sensor) → respawn
    if (body.translation().y < -10) {
      body.setTranslation({ x: spawn.x, y: 2, z: spawn.z }, true)
      body.setRotation(yawQuat(spawn.yaw), true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }

    const speed = controller.currentVehicleSpeed()
    const forward = pressed.has('KeyW') || pressed.has('ArrowUp')
    const back = pressed.has('KeyS') || pressed.has('ArrowDown')
    let steer = 0
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) steer += 1
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) steer -= 1

    let engine = 0
    let brake = 0
    if (forward) engine = ENGINE_FORCE
    else if (back) {
      // brake while rolling forward, reverse once near-stopped
      if (speed > 0.5) brake = BRAKE_FORCE
      else engine = -REVERSE_FORCE
    }
    const steerAngle = steer * MAX_STEER * (1 / (1 + Math.abs(speed) * 0.08))
    for (const i of REAR) controller.setWheelEngineForce(i, engine)
    for (let i = 0; i < WHEELS.length; i++) controller.setWheelBrake(i, brake)
    for (const i of FRONT) controller.setWheelSteering(i, steerAngle)

    // vehicle controllers are not auto-stepped; rays only hit static city colliders
    controller.updateVehicle(w.timestep)
    useDriveHud.getState().setSpeed(Math.round(Math.abs(controller.currentVehicleSpeed()) * 3.6))
  })

  const camTarget = useMemo(() => new THREE.Vector3(), [])
  const camPos = useMemo(() => new THREE.Vector3(), [])
  const fwd = useMemo(() => new THREE.Vector3(), [])
  const quat = useMemo(() => new THREE.Quaternion(), [])

  useFrame((_, dt) => {
    const body = chassis.current
    if (!body) return
    const t = body.translation()
    const r = body.rotation()
    quat.set(r.x, r.y, r.z, r.w)
    fwd.set(0, 0, 1).applyQuaternion(quat)
    camPos.set(t.x - fwd.x * 9, t.y + 3.2, t.z - fwd.z * 9)
    camera.position.lerp(camPos, 1 - Math.exp(-6 * Math.min(dt, 0.05)))
    camTarget.set(t.x + fwd.x * 6, t.y + 1, t.z + fwd.z * 6)
    camera.lookAt(camTarget)
  })

  return (
    <RigidBody
      ref={chassis}
      colliders={false}
      ccd
      position={[spawn.x, 2, spawn.z]}
      rotation={[0, spawn.yaw, 0]}
    >
      <CuboidCollider args={CHASSIS_HALF} mass={1200} />
      <mesh castShadow>
        <boxGeometry args={[CHASSIS_HALF[0] * 2, CHASSIS_HALF[1] * 2, CHASSIS_HALF[2] * 2]} />
        <meshStandardMaterial color="#c33f2e" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.7, -0.3]} castShadow>
        <boxGeometry args={[1.5, 0.55, 2.1]} />
        <meshStandardMaterial color="#2b2f33" roughness={0.3} metalness={0.2} />
      </mesh>
    </RigidBody>
  )
}

function yawQuat(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
}
