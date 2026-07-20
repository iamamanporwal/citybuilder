import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, Sky } from '@react-three/drei'
import { Bloom, BrightnessContrast, EffectComposer, HueSaturation, N8AO, SMAA, Vignette } from '@react-three/postprocessing'
import { useEditor } from '../state/store'
import { CameraRig } from './CameraRig'
import { SceneContent } from './SceneContent'
import { lastOrbitTarget } from './bus'
import { DEPTH_CONFIG } from './depthConfig'
import { QUALITY_PRESETS } from '../types'

// physics drive preview: code-split so the rapier wasm loads on first use only
const DriveSim = lazy(() => import('./driving/DriveSim'))

/**
 * EDITOR-ONLY look-dev preview. The authoring tool ships clean unlit PBR
 * content — lighting, post-FX, reflections and sky live in the game engine.
 * This composer approximates the engine's grade so artists can sanity-check;
 * nothing here is baked into textures or written to the export.
 */
function FxPreview() {
  const on = useEditor((s) => s.fxPreview)
  const mode = useEditor((s) => s.cameraMode)
  if (!on) return null
  // Phase 1 look-dev grade (docs/road-visual-techniques-research.md §Roadmap).
  // Order matters: AO composites into the lit image first (reading depth — N8AO
  // auto-detects our logarithmicDepthBuffer and is fog-aware), then bloom, then
  // colour grade, with SMAA last as the antialias resolve. Tone mapping stays on
  // the renderer (R3F default ACES) — adding a ToneMapping effect here would
  // double-grade. Half-res AO while driving (frameloop=always) keeps fill-rate
  // sane; full-res in orbit for crisp contact darkening on curbs/cracks.
  return (
    <EffectComposer>
      <N8AO
        aoRadius={3}
        distanceFalloff={1}
        intensity={1.8}
        quality="medium"
        halfRes={mode === 'drive'}
      />
      <Bloom intensity={0.28} luminanceThreshold={0.85} mipmapBlur />
      <HueSaturation saturation={0.08} hue={0} />
      <BrightnessContrast brightness={0.02} contrast={0.12} />
      <Vignette eskil={false} offset={0.22} darkness={0.5} />
      <SMAA />
    </EffectComposer>
  )
}

// Aerial perspective: a subtle sun-tinted exponential haze so distant geometry
// fades toward the horizon (depth cue + hides the LOD/streaming edge). Preview-
// only and gated by fxPreview, so the clean-content default is untouched and the
// A/B stays meaningful. Not exported (GLTFExporter ignores scene.fog); N8AO reads
// it to keep AO fog-aware. FogExp2 is view-distance based, independent of the
// log-depth buffer. Modern three recompiles materials when scene.fog toggles.
function AerialFog() {
  const on = useEditor((s) => s.fxPreview)
  const sunTime = useEditor((s) => s.sunTime)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (on) {
      // warmer haze near sunrise/sunset, cooler at midday
      const t = Math.min(Math.max((sunTime - 6) / 12, 0), 1)
      const warm = new THREE.Color('#d8c2a6')
      const cool = new THREE.Color('#bcc9d6')
      const c = warm.clone().lerp(cool, Math.sin(t * Math.PI))
      scene.fog = new THREE.FogExp2(c.getHex(), 0.00026)
    } else {
      scene.fog = null
    }
    invalidate()
    return () => {
      scene.fog = null
      invalidate()
    }
  }, [on, sunTime, scene, invalidate])
  return null
}

// Dev-only bridge for scripted QA (Playwright): position the camera exactly and
// introspect the scene without going through pointer gestures. No-op in prod.
function DebugBridge() {
  const { camera, scene, gl } = useThree()
  const get = useThree((s) => s.get)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const api = {
      camera,
      scene,
      gl,
      // Teleport the orbit camera: position + look target. Orbit controls keep
      // the pose stable (fly mode would re-assert its own yaw/pitch each frame).
      setCam(pos: [number, number, number], look: [number, number, number]) {
        useEditor.getState().setCameraMode('orbit')
        camera.position.set(pos[0], pos[1], pos[2])
        const ctrl: any = get().controls
        if (ctrl) {
          ctrl.target.set(look[0], look[1], look[2])
          ctrl.update()
        } else {
          camera.lookAt(look[0], look[1], look[2])
        }
        camera.updateMatrixWorld(true)
      },
      store: useEditor,
      THREE,
    }
    ;(window as any).__cb = api
    return () => {
      if ((window as any).__cb === api) delete (window as any).__cb
    }
  }, [camera, scene, gl, get])
  return null
}

// On-demand rendering: in orbit mode the viewport only renders when something
// changes (camera damping self-invalidates via MapControls). MapControls covers
// camera motion; this bridges the imperative/store-driven changes that alter the
// scene without a camera move — selection highlight, sun/time, FX toggle, and any
// object edit (transform/swap/delete/visibility, which replace the objects map).
// Fly/drive keep frameloop="always" (continuous integration), so this is a no-op
// there. Extra invalidations are harmless; a missed one would freeze the view.
function Invalidator() {
  const invalidate = useThree((s) => s.invalidate)
  const selection = useEditor((s) => s.selection)
  const selectedInstance = useEditor((s) => s.selectedInstance)
  const sunTime = useEditor((s) => s.sunTime)
  const fxPreview = useEditor((s) => s.fxPreview)
  const objectOrder = useEditor((s) => s.objectOrder)
  const objects = useEditor((s) => s.objects)
  const cameraMode = useEditor((s) => s.cameraMode)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  useEffect(() => {
    invalidate()
  }, [invalidate, selection, selectedInstance, sunTime, fxPreview, objectOrder, objects, cameraMode, gizmoMode])
  return null
}

// Drive mode renders an eye-level view down long streets (deep frustum, many
// buildings). Drop the render resolution there to keep 60fps; orbit/fly stay at
// full retina. Slightly softer while driving, big fill-rate win.
function DprController() {
  const mode = useEditor((s) => s.cameraMode)
  const quality = useEditor((s) => s.quality3d)
  const setDpr = useThree((s) => s.setDpr)
  useEffect(() => {
    const devCap = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio, 2) : 2
    const cap = Math.min(devCap, QUALITY_PRESETS[quality].dprCap)
    setDpr(mode === 'drive' ? Math.min(cap, 1.25) : cap)
  }, [mode, quality, setDpr])
  return null
}

function Lighting() {
  const mode = useEditor((s) => s.cameraMode)
  const sunTime = useEditor((s) => s.sunTime)
  const quality = useEditor((s) => s.quality3d)
  const preset = QUALITY_PRESETS[quality]
  // Shadow map resolution comes from the quality preset; driving still caps it at
  // 1024 to keep the eye-level frustum cheap. Keyed so the change recreates the
  // shadow map. Performance preset disables shadow casting entirely.
  const shadowRes = mode === 'drive' ? Math.min(preset.shadowRes, 1024) : preset.shadowRes
  const sun = useMemo(() => {
    const a = ((sunTime - 6) / 12) * Math.PI // 6:00 -> sunrise, 18:00 -> sunset
    const elev = Math.sin(a)
    return {
      pos: [Math.cos(a) * 900, Math.max(elev, 0.03) * 700 + 40, 350] as [number, number, number],
      intensity: Math.max(elev, 0) * 2.0 + 0.15,
      ambient: Math.max(elev, 0) * 0.9 + 0.5,
    }
  }, [sunTime])
  const sunDir = useMemo(() => new THREE.Vector3(sun.pos[0], sun.pos[1], sun.pos[2]).normalize(), [sun.pos])
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const { scene, camera } = useThree()
  const focus = useMemo(() => new THREE.Vector3(), [])

  // The shadow frustum follows the view and scales with zoom, so large cities
  // stay lit off-origin instead of only within a fixed ±650 m box at (0,0).
  useFrame(() => {
    const l = lightRef.current
    if (!l) return
    if (l.target.parent !== scene) scene.add(l.target) // survives shadowRes remounts
    if (useEditor.getState().cameraMode === 'orbit') {
      focus.copy(lastOrbitTarget)
    } else {
      const fwd = new THREE.Vector3()
      camera.getWorldDirection(fwd)
      const t = Math.abs(fwd.y) > 1e-3 ? -camera.position.y / fwd.y : -1
      if (t > 0 && t < 5000) focus.copy(camera.position).addScaledVector(fwd, t)
      else focus.set(camera.position.x, 0, camera.position.z)
    }
    l.target.position.copy(focus)
    l.position.copy(focus).addScaledVector(sunDir, 900)
    l.target.updateMatrixWorld()
    const half = Math.min(Math.max(camera.position.distanceTo(focus) * 0.7, 650), 2600)
    const cam = l.shadow.camera as THREE.OrthographicCamera
    if (Math.abs(cam.right - half) > 8) { // avoid a per-frame projection rebuild while dollying
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half
      cam.far = Math.max(3000, half * 2 + 1500)
      cam.updateProjectionMatrix()
    }
  })

  return (
    <>
      <Sky sunPosition={sun.pos} distance={4000} turbidity={6} rayleigh={1.2} />
      <hemisphereLight args={['#c6d8ea', '#57584e', sun.ambient]} />
      <ambientLight intensity={0.18} />
      <directionalLight
        ref={lightRef}
        key={`${shadowRes}-${preset.shadows}`}
        position={sun.pos}
        intensity={sun.intensity}
        castShadow={preset.shadows}
        shadow-mapSize={[shadowRes, shadowRes]}
        shadow-camera-left={-650}
        shadow-camera-right={650}
        shadow-camera-top={650}
        shadow-camera-bottom={-650}
        shadow-camera-near={10}
        shadow-camera-far={3000}
        shadow-bias={-0.0002}
        shadow-normalBias={0.6}
      />
    </>
  )
}

export function Viewport() {
  const clearSelection = useEditor((s) => s.clearSelection)
  const mode = useEditor((s) => s.cameraMode)
  const gizmoDragging = useEditor((s) => s.gizmoDragging)
  // Render only when needed while orbiting a static city (the common case) — the
  // single biggest FPS/thermal win. Fly/drive integrate every frame, and a live
  // gizmo drag needs continuous frames, so those stay "always".
  const frameloop = mode === 'orbit' && !gizmoDragging ? 'demand' : 'always'
  return (
    <Canvas
      frameloop={frameloop}
      shadows
      camera={{ position: [-340, 300, 340], fov: 55, near: DEPTH_CONFIG.near, far: DEPTH_CONFIG.far }}
      // logarithmicDepthBuffer is load-bearing: with standard perspective depth
      // the layer stack (10-30mm gaps) drops below the depth quantum beyond
      // ~350m viewing distance and z-fights. flickerLint proves this invariant.
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        logarithmicDepthBuffer: DEPTH_CONFIG.logarithmicDepthBuffer,
      }}
      onPointerMissed={(e) => {
        if (e.type === 'click') clearSelection()
      }}
      dpr={[1, 2]}
    >
      <DebugBridge />
      <Invalidator />
      <DprController />
      <Lighting />
      <AerialFog />
      <SceneContent />
      <CameraRig />
      {/* navigation cube (orbit only — it drives the orbit controls): click a
          face/axis to snap to top/front/side, or drag it to spin the view */}
      {mode === 'orbit' && (
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport
            axisColors={['#e0533d', '#7bb662', '#4a90d9']}
            labelColor="#12151a"
          />
        </GizmoHelper>
      )}
      {mode === 'drive' && (
        <Suspense fallback={null}>
          <DriveSim />
        </Suspense>
      )}
      <FxPreview />
    </Canvas>
  )
}
