import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Html, TransformControls } from '@react-three/drei'
import { useEditor } from '../state/store'
import { getVariant } from '../scene/registry'
import { tickOcean } from '../procgen/areas'
import type { SceneObject } from '../types'

const PROC_FALLBACK = {
  state: 'procedural' as const,
  provider: 'procedural' as const,
  license: '',
  approved: true,
}

function currentObject3D(obj: SceneObject): THREE.Object3D | undefined {
  return getVariant(obj.id, obj.asset) ?? getVariant(obj.id, PROC_FALLBACK)
}

function ObjectNode({ id }: { id: string }) {
  const obj = useEditor((s) => s.objects[id])
  const job = useEditor((s) => s.jobs[id])
  const select = useEditor((s) => s.select)
  const clearSelection = useEditor((s) => s.clearSelection)

  const three = obj ? currentObject3D(obj) : undefined
  if (!obj || !three || obj.deleted || !obj.visible) return null

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // selectable in orbit AND fly (drive is hands-on-wheel); the guard used to
    // be orbit-only, which silently broke the "click any object" model in fly
    if (useEditor.getState().cameraMode === 'drive') return
    if (e.delta > 6) return // was a camera drag/look, not a click
    e.stopPropagation()
    if (obj.type === 'ground') {
      clearSelection()
      return
    }
    // instanced props (streetlights/benches/bins/trees) are one object holding
    // many items — resolve the clicked instance so selection highlights per-item
    const instanceId = e.instanceId
    select([obj.id], e.nativeEvent.shiftKey)
    useEditor.getState().setSelectedInstance(
      instanceId != null && (obj.type === 'street-furniture' || obj.type === 'vegetation')
        ? { objectId: obj.id, index: instanceId, meshUuid: e.object.uuid }
        : null,
    )
  }

  const height = typeof obj.meta['height (m)'] === 'number' ? (obj.meta['height (m)'] as number) : 20

  return (
    <>
      <primitive
        object={three}
        position={obj.transform.position}
        rotation={obj.transform.rotation}
        scale={obj.transform.scale}
        onClick={onClick}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          if (obj.type === 'ground' || useEditor.getState().cameraMode === 'drive') return
          e.stopPropagation()
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => { document.body.style.cursor = '' }}
      />
      {job && (
        <Html
          center
          position={[obj.transform.position[0], height + 14, obj.transform.position[2]]}
          zIndexRange={[100, 0]}
        >
          <div className="scene-job">
            <div className="spinner" />
            <div className="scene-job-text">
              {job.message}
              <div className="scene-job-bar">
                <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
            </div>
          </div>
        </Html>
      )}
    </>
  )
}

function boxInstance(box: THREE.Box3, im: THREE.InstancedMesh, index: number): boolean {
  if (index < 0 || index >= im.count) return false
  if (!im.geometry.boundingBox) im.geometry.computeBoundingBox()
  const m = new THREE.Matrix4()
  im.getMatrixAt(index, m)
  box.copy(im.geometry.boundingBox!).applyMatrix4(m).applyMatrix4(im.matrixWorld)
  return true
}

function SelectionBox({ id }: { id: string }) {
  const box = useMemo(() => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)), [])
  const helper = useRef<THREE.Box3Helper>(null)
  useFrame(() => {
    const st = useEditor.getState()
    const obj = st.objects[id]
    if (!obj) return
    const three = currentObject3D(obj)
    if (!three || !three.parent) return
    // when a specific instance of an instanced group was clicked, box just it
    const inst = st.selectedInstance
    if (inst && inst.objectId === id) {
      let target: THREE.InstancedMesh | null = null
      three.traverse((o) => {
        if (!target && o.uuid === inst.meshUuid && (o as THREE.InstancedMesh).isInstancedMesh) target = o as THREE.InstancedMesh
      })
      if (target && boxInstance(box, target, inst.index)) return
    }
    box.setFromObject(three)
  })
  return <box3Helper ref={helper} args={[box, new THREE.Color('#ffc53d')]} />
}

/** Gizmo for the single selected, unlocked object. Commits transforms for undo. */
function Gizmo() {
  const selection = useEditor((s) => s.selection)
  const gizmoMode = useEditor((s) => s.gizmoMode)
  const snapping = useEditor((s) => s.snapping)
  const cameraMode = useEditor((s) => s.cameraMode)
  const obj = useEditor((s) => (selection.length === 1 ? s.objects[selection[0]] : undefined))
  const before = useRef<SceneObject['transform'] | null>(null)

  if (cameraMode !== 'orbit' || !obj || obj.locked || obj.deleted || !obj.visible) return null
  const three = currentObject3D(obj)
  if (!three) return null

  return (
    <TransformControls
      object={three}
      mode={gizmoMode}
      translationSnap={snapping ? 0.5 : null}
      rotationSnap={snapping ? THREE.MathUtils.degToRad(15) : null}
      scaleSnap={snapping ? 0.1 : null}
      size={0.8}
      onMouseDown={() => {
        before.current = {
          position: [...obj.transform.position] as [number, number, number],
          rotation: [...obj.transform.rotation] as [number, number, number],
          scale: [...obj.transform.scale] as [number, number, number],
        }
        useEditor.getState().setGizmoDragging(true)
      }}
      onMouseUp={() => {
        useEditor.getState().setGizmoDragging(false)
        if (!before.current) return
        const after = {
          position: three.position.toArray() as [number, number, number],
          rotation: [three.rotation.x, three.rotation.y, three.rotation.z] as [
            number,
            number,
            number,
          ],
          scale: three.scale.toArray() as [number, number, number],
        }
        useEditor.getState().commitTransform(obj.id, before.current, after)
        before.current = null
      }}
    />
  )
}

/** Drives the shared animated ocean uniform every frame (mounted once). */
function OceanTicker() {
  useFrame((state) => tickOcean(state.clock.elapsedTime))
  return null
}

export function SceneContent() {
  const order = useEditor((s) => s.objectOrder)
  const selection = useEditor((s) => s.selection)
  return (
    <group>
      <OceanTicker />
      {order.map((id) => (
        <ObjectNode key={id} id={id} />
      ))}
      {selection.map((id) => (
        <SelectionBox key={`sel_${id}`} id={id} />
      ))}
      <Gizmo />
    </group>
  )
}
