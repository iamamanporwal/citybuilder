import * as THREE from 'three'
import { useEditor } from '../state/store'
import { getVariant } from '../scene/registry'
import { frameBus } from './bus'

/** Frame the camera on a set of objects (F key, hierarchy double-click). */
export function frameObjects(ids: string[]) {
  const s = useEditor.getState()
  const box = new THREE.Box3()
  let any = false
  for (const id of ids) {
    const obj = s.objects[id]
    if (!obj || obj.deleted) continue
    const three = getVariant(obj.id, obj.asset)
    if (!three) continue
    const b = new THREE.Box3().setFromObject(three)
    if (!b.isEmpty()) {
      box.union(b)
      any = true
    }
  }
  if (!any) return
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5)
  frameBus.emit({ center, radius })
}
