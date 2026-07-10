import { useRef } from 'react'
import type { SceneObject } from '../types'
import { useEditor } from '../state/store'
import { PROVIDERS, runGeneration, uploadModel } from '../gateway/providers'

/** Per-object provider menu (PRD §9.2) — buildings only, never roads. */
export function ReplacePanel({ obj }: { obj: SceneObject }) {
  const job = useEditor((s) => s.jobs[obj.id])
  const fileRef = useRef<HTMLInputElement>(null)
  const s = useEditor.getState

  const activeProvider =
    obj.asset.state === 'procedural' ? 'procedural' : obj.asset.provider

  const choose = (id: string) => {
    if (job) return
    switch (id) {
      case 'procedural':
        if (obj.asset.state !== 'procedural') {
          s().swapAsset(obj.id, {
            state: 'procedural',
            provider: 'procedural',
            license: 'generated-internal',
            approved: true,
          })
          s().showToast('Reverted to the procedural placeholder')
        }
        break
      case 'trellis-local':
        runGeneration(obj.id, 'trellis-local')
        break
      case 'upload':
        fileRef.current?.click()
        break
    }
  }

  return (
    <div className="replace-panel">
      <div className="section-title">Replace this object</div>
      <div className="section-hint">
        The slot (position, footprint, height) stays fixed — any source is fitted into it.
      </div>
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          className={`provider ${activeProvider === p.id ? 'provider-active' : ''} ${!p.available ? 'provider-disabled' : ''}`}
          disabled={!p.available || !!job}
          onClick={() => choose(p.id)}
          title={p.unavailableReason ?? p.detail}
        >
          <span className="provider-head">
            <span>{p.label}</span>
            <span className="provider-cost">{p.cost}</span>
          </span>
          <span className="provider-detail">
            {p.available ? p.detail : `🔒 ${p.unavailableReason}`}
          </span>
        </button>
      ))}
      {job && (
        <div className="job-row">
          <div className="spinner small" />
          <div className="job-info">
            {job.message}
            <div className="scene-job-bar">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) uploadModel(obj.id, f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
