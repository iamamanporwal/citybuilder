import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { CuboidCollider, RigidBody, useBeforePhysicsStep, useRapier, type RapierRigidBody } from '@react-three/rapier'
import type { DynamicRayCastVehicleController } from '@dimforge/rapier3d-compat'
import { focusState, focusTarget, lastOrbitTarget, nearestRoadPoint } from '../bus'
import { sampleTerrain } from '../../procgen/terrain/field'
import { pressed } from '../input'
import { useDriveHud } from '../../state/driveHud'

// Physics car for the drive preview: dynamic cuboid chassis + Rapier's
// DynamicRayCastVehicleController (raycast wheels — no wheel colliders or
// joints to tune). Rear-wheel drive, speed-sensitive steering, chase camera.
//
// Physics is deliberately ARCADE/minimal: pitch and roll are locked on the
// chassis (enabledRotations = yaw only) so the car can never flip or roll over
// under braking, cornering or collisions. Linear damping keeps stops smooth.

const CHASSIS_HALF: [number, number, number] = [0.9, 0.55, 2.2]
const WHEEL_RADIUS = 0.35
const WHEEL_WIDTH = 0.28
const SUSPENSION_REST = 0.35
// wheel connection points in chassis-local space (front pair first)
const WHEELS: [number, number, number][] = [
  [-0.85, -0.3, 1.5],
  [0.85, -0.3, 1.5],
  [-0.85, -0.3, -1.5],
  [0.85, -0.3, -1.5],
]
// visual wheel centers (sit a touch wider + lower than the ray connection pts)
const VIS_WHEELS: [number, number, number][] = [
  [-0.92, -0.42, 1.5],
  [0.92, -0.42, 1.5],
  [-0.92, -0.42, -1.5],
  [0.92, -0.42, -1.5],
]
const FRONT = [0, 1]
const REAR = [2, 3]
const ENGINE_FORCE = 4500 // per rear wheel
const BRAKE_FORCE = 2200 // per wheel — gentle so stops don't pitch the body
const REVERSE_FORCE = 2500
const MAX_STEER = 0.55 // rad, tapered with speed

export function Car() {
  const { world } = useRapier()
  const { camera } = useThree()
  const chassis = useRef<RapierRigidBody>(null)
  const vc = useRef<DynamicRayCastVehicleController | null>(null)

  // live values published by the physics step, consumed by the render frame
  // to animate the visible wheels (spin + front-wheel steering).
  const steerRef = useRef(0)
  const speedRef = useRef(0)
  const spinRef = useRef(0)
  const outerWheels = useRef<(THREE.Group | null)[]>([])
  const spinWheels = useRef<(THREE.Group | null)[]>([])

  const spawn = useMemo(() => {
    // spawn on the road nearest the focused object (selection) if there is one,
    // else where the user was looking in orbit
    const f = focusState.has ? focusTarget : lastOrbitTarget
    const s = nearestRoadPoint(f.x, f.z)
    // seat the spawn on the terrain so the car drops onto the road, not through a
    // hilltop or high above a valley floor (y is 0 when terrain is off)
    return { x: s.x, z: s.z, y: sampleTerrain(s.x, s.z), yaw: Math.atan2(s.hx, s.hz) } // local +z is forward
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
      controller.setWheelSuspensionStiffness(i, 18)
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

    // kill-plane: fell off the world (e.g. through a water sensor) → respawn.
    // Relative to the spawn's terrain height so a valley floor never trips it.
    if (body.translation().y < spawn.y - 12) {
      body.setTranslation({ x: spawn.x, y: spawn.y + 2, z: spawn.z }, true)
      body.setRotation(yawQuat(spawn.yaw), true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }

    const speed = controller.currentVehicleSpeed()
    const forward = pressed.has('KeyW') || pressed.has('ArrowUp')
    const back = pressed.has('KeyS') || pressed.has('ArrowDown')
    let steer = 0
    // A / ← steers left (positive angle → +X → left with forward=+Z), D / → right
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
    const v = controller.currentVehicleSpeed()
    steerRef.current = steerAngle
    speedRef.current = v
    useDriveHud.getState().setSpeed(Math.round(Math.abs(v) * 3.6))
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

    // animate visible wheels: roll all four, steer the front pair
    spinRef.current -= (speedRef.current * Math.min(dt, 0.05)) / WHEEL_RADIUS
    const spin = spinRef.current
    for (let i = 0; i < spinWheels.current.length; i++) {
      const g = spinWheels.current[i]
      if (g) g.rotation.x = spin
    }
    for (const i of FRONT) {
      const g = outerWheels.current[i]
      if (g) g.rotation.y = steerRef.current
    }
  })

  return (
    <RigidBody
      ref={chassis}
      colliders={false}
      ccd
      position={[spawn.x, spawn.y + 2, spawn.z]}
      rotation={[0, spawn.yaw, 0]}
      // arcade physics: lock pitch & roll so the car can never flip
      enabledRotations={[false, true, false]}
      linearDamping={0.4}
      angularDamping={0.6}
    >
      <CuboidCollider args={CHASSIS_HALF} mass={1200} />
      <CarBody outerWheels={outerWheels} spinWheels={spinWheels} />
    </RigidBody>
  )
}

// Procedural car body: recognizable silhouette (lower body + cabin + slanted
// windshield + wheel arches), four visible wheels, and light accents. Purely
// visual — no colliders — so physics is untouched.
function CarBody({
  outerWheels,
  spinWheels,
}: {
  outerWheels: React.MutableRefObject<(THREE.Group | null)[]>
  spinWheels: React.MutableRefObject<(THREE.Group | null)[]>
}) {
  const bodyPaint = useMemo(
    () => <meshStandardMaterial color="#c8442f" roughness={0.35} metalness={0.35} />,
    [],
  )
  return (
    <group>
      {/* lower body / sills */}
      <mesh castShadow position={[0, -0.12, 0]}>
        <boxGeometry args={[1.72, 0.62, 4.3]} />
        {bodyPaint}
      </mesh>
      {/* hood + rear deck (slightly narrower upper body) */}
      <mesh castShadow position={[0, 0.24, 0.35]}>
        <boxGeometry args={[1.66, 0.34, 3.3]} />
        {bodyPaint}
      </mesh>
      {/* cabin */}
      <mesh castShadow position={[0, 0.62, -0.35]}>
        <boxGeometry args={[1.5, 0.6, 1.9]} />
        <meshStandardMaterial color="#20242a" roughness={0.5} metalness={0.15} />
      </mesh>
      {/* windshield (slanted glass) */}
      <mesh position={[0, 0.62, 0.72]} rotation={[-0.62, 0, 0]}>
        <boxGeometry args={[1.42, 0.62, 0.06]} />
        <meshStandardMaterial color="#9fd3e6" roughness={0.08} metalness={0.1} transparent opacity={0.65} />
      </mesh>
      {/* rear glass */}
      <mesh position={[0, 0.64, -1.28]} rotation={[0.7, 0, 0]}>
        <boxGeometry args={[1.4, 0.5, 0.06]} />
        <meshStandardMaterial color="#9fd3e6" roughness={0.08} metalness={0.1} transparent opacity={0.65} />
      </mesh>
      {/* headlights (front = +z) */}
      <mesh position={[0.6, 0.02, 2.16]}>
        <boxGeometry args={[0.34, 0.16, 0.06]} />
        <meshStandardMaterial color="#fffdf0" emissive="#fff3c0" emissiveIntensity={0.8} />
      </mesh>
      <mesh position={[-0.6, 0.02, 2.16]}>
        <boxGeometry args={[0.34, 0.16, 0.06]} />
        <meshStandardMaterial color="#fffdf0" emissive="#fff3c0" emissiveIntensity={0.8} />
      </mesh>
      {/* taillights (rear = -z) */}
      <mesh position={[0.62, 0.06, -2.16]}>
        <boxGeometry args={[0.3, 0.16, 0.06]} />
        <meshStandardMaterial color="#7a0e0e" emissive="#ff2a2a" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[-0.62, 0.06, -2.16]}>
        <boxGeometry args={[0.3, 0.16, 0.06]} />
        <meshStandardMaterial color="#7a0e0e" emissive="#ff2a2a" emissiveIntensity={0.6} />
      </mesh>

      {VIS_WHEELS.map((p, i) => (
        <group key={i} position={p} ref={(g) => (outerWheels.current[i] = g)}>
          <group ref={(g) => (spinWheels.current[i] = g)}>
            {/* tyre — cylinder axis rotated onto X (the axle) */}
            <mesh castShadow rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 22]} />
              <meshStandardMaterial color="#16181b" roughness={0.85} metalness={0.1} />
            </mesh>
            {/* hub cap for a visible spin reference */}
            <mesh position={[p[0] < 0 ? -WHEEL_WIDTH / 2 - 0.01 : WHEEL_WIDTH / 2 + 0.01, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[WHEEL_RADIUS * 0.5, WHEEL_RADIUS * 0.5, 0.02, 16]} />
              <meshStandardMaterial color="#c9ced3" roughness={0.3} metalness={0.7} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  )
}

function yawQuat(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
}
