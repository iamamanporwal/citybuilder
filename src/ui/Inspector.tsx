import { useEffect, useState } from 'react'
import type { SceneObject, Transform } from '../types'
import { useEditor } from '../state/store'
import { ReplacePanel } from './ReplacePanel'
import { frameObjects } from '../editor/actions'
import { buildingResolutions, replaceables, roadResolutions } from '../scene/registry'
import { matrixToJSON } from '../resolver/matrix'

function downloadMatrix() {
  const blob = new Blob([JSON.stringify(matrixToJSON(), null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `content_matrix_${matrixToJSON().version}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/** Why this object looks the way it does — the resolver's decision trail. */
function ResolutionSection({ obj }: { obj: SceneObject }) {
  const res = buildingResolutions.get(obj.id) ?? roadResolutions.get(obj.id)
  if (!res) return null
  return (
    <div className="section">
      <div className="section-title">Content resolution</div>
      <div className="kv">
        <span>confidence</span>
        <span>
          <span className={`conf conf-${res.confidence >= 0.7 ? 'high' : res.confidence >= 0.5 ? 'mid' : 'low'}`}>
            {Math.round(res.confidence * 100)}%
          </span>
        </span>
      </div>
      <div className="provenance">
        {res.provenance.map((line, i) => (
          <div key={i} className="prov-line">{line}</div>
        ))}
      </div>
    </div>
  )
}

const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180

function NumberField({
  value,
  onCommit,
  step = 0.1,
}: {
  value: number
  onCommit: (v: number) => void
  step?: number
}) {
  const [text, setText] = useState(value.toFixed(2))
  useEffect(() => setText(value.toFixed(2)), [value])
  const commit = () => {
    const v = parseFloat(text)
    if (isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v)
    else setText(value.toFixed(2))
  }
  return (
    <input
      className="num"
      value={text}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function TransformEditor({ obj }: { obj: SceneObject }) {
  const commitTransform = useEditor.getState().commitTransform
  const t = obj.transform
  const update = (patch: Partial<Transform>) => {
    commitTransform(obj.id, t, { ...t, ...patch })
  }
  const rows: {
    label: string
    values: number[]
    toDisplay: (v: number) => number
    fromDisplay: (v: number) => number
    key: keyof Transform
  }[] = [
    { label: 'Position (m)', values: [...t.position], toDisplay: (v) => v, fromDisplay: (v) => v, key: 'position' },
    { label: 'Rotation (°)', values: [...t.rotation], toDisplay: (v) => v * RAD2DEG, fromDisplay: (v) => v * DEG2RAD, key: 'rotation' },
    { label: 'Scale', values: [...t.scale], toDisplay: (v) => v, fromDisplay: (v) => v, key: 'scale' },
  ]
  return (
    <div className="section">
      <div className="section-title">Transform</div>
      {rows.map((r) => (
        <div className="trow" key={r.label}>
          <span className="tlabel">{r.label}</span>
          {[0, 1, 2].map((i) => (
            <NumberField
              key={i}
              value={r.toDisplay(r.values[i])}
              onCommit={(v) => {
                const next = [...r.values] as [number, number, number]
                next[i] = r.fromDisplay(v)
                update({ [r.key]: next } as Partial<Transform>)
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ReferenceSection({ obj }: { obj: SceneObject }) {
  const [img, setImg] = useState<string | null>(null)
  const rw = obj.realworld
  useEffect(() => {
    setImg(null)
    if (!rw?.wikidata) return
    let cancelled = false
    fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${rw.wikidata}&property=P18&format=json&origin=*`,
    )
      .then((r) => r.json())
      .then((d) => {
        const file = d?.claims?.P18?.[0]?.mainsnak?.datavalue?.value
        if (file && !cancelled)
          setImg(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480`)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rw?.wikidata])

  if (!rw) return null
  return (
    <div className="section">
      <div className="section-title">Real-world reference</div>
      {img && <img className="ref-img" src={img} alt="Reference" />}
      {!img && rw.wikidata && <div className="ref-loading">Fetching reference photo…</div>}
      <div className="ref-links">
        <a href={rw.mapUrl} target="_blank" rel="noreferrer">🗺 View on map</a>
        <a href={rw.streetViewUrl} target="_blank" rel="noreferrer">👁 Street View</a>
        {rw.wikidata && (
          <a href={`https://www.wikidata.org/wiki/${rw.wikidata}`} target="_blank" rel="noreferrer">
            ℹ Wikidata
          </a>
        )}
      </div>
      <div className="ref-coords">
        {rw.lat.toFixed(5)}, {rw.lng.toFixed(5)}
      </div>
    </div>
  )
}

/** Build context: resolver inputs, adapter sources, matrix version, variety lint. */
function ContextPanel() {
  const info = useEditor((s) => s.contextInfo)
  const lint = useEditor((s) => s.lintReport)
  const [open, setOpen] = useState(false)
  if (!info) return null
  return (
    <>
      <div className="section">
        <div className="section-title">Build context</div>
        <div className="kv"><span>region pack</span><span>{info.regionLabel}</span></div>
        <div className="kv"><span>climate</span><span>{info.climate}</span></div>
        <div className="kv"><span>tree species</span><span>{info.treePoolSource}</span></div>
        <div className="kv"><span>land cover</span><span>{info.landCoverSource}</span></div>
        <div className="kv"><span>matrix</span><span>v{info.matrixVersion}</span></div>
        <button className="wide" onClick={() => setOpen(!open)}>
          {open ? '▾ Hide' : '▸ Show'} adapter log
        </button>
        {open && (
          <div className="provenance">
            {info.provenance.map((l, i) => (
              <div key={i} className="prov-line">{l}</div>
            ))}
          </div>
        )}
        <button className="wide" onClick={downloadMatrix} title="The full content matrix as versioned JSON — inspect, diff, tune">
          ⬇ Content matrix (JSON)
        </button>
      </div>
      <div className="section">
        <div className="section-title">Variety linter</div>
        {lint.map((w, i) => (
          <div key={i} className={`lint lint-${w.severity}`}>
            {w.severity === 'warn' ? '⚠' : 'ℹ'} {w.message}
          </div>
        ))}
      </div>
    </>
  )
}

const STATE_LABEL: Record<string, string> = {
  procedural: 'Procedural (data-driven placeholder)',
  generated: 'AI-generated',
  library: 'Library asset',
  uploaded: 'Uploaded model',
}

export function Inspector() {
  const selection = useEditor((s) => s.selection)
  const objects = useEditor((s) => s.objects)
  const report = useEditor((s) => s.report)
  const cityName = useEditor((s) => s.cityName)
  const s = useEditor.getState

  if (selection.length === 0) {
    return (
      <div className="panel inspector">
        <div className="panel-title">Inspector</div>
        <div className="section">
          <div className="section-title">{cityName || 'City'}</div>
          {report && (
            <div className="report">
              <div>🏢 {report.buildingCount} buildings <span className="muted">({report.buildingsWithHeight} with real heights)</span></div>
              <div>🛣️ {report.roadCount} road segments</div>
              <div>🚦 {report.signalCount} traffic signals · 🌳 {report.treeCount} trees</div>
            </div>
          )}
        </div>
        <ContextPanel />
        <div className="section quickstart">
          <div className="section-title">Get started</div>
          <ol>
            <li><b>Click any building</b> in the 3D view to inspect it.</li>
            <li>Use <b>Replace this object</b> to upgrade it with AI or your own model.</li>
            <li>Press <b>D</b> to drive the city at eye level.</li>
            <li><b>Export city</b> when it looks right from the road.</li>
          </ol>
        </div>
      </div>
    )
  }

  if (selection.length > 1) {
    return (
      <div className="panel inspector">
        <div className="panel-title">Inspector</div>
        <div className="section">
          <div className="section-title">{selection.length} objects selected</div>
          <button className="wide" onClick={() => frameObjects(selection)}>⌖ Frame selection (F)</button>
          <button className="wide danger" onClick={() => s().deleteSelected()}>🗑 Delete unlocked</button>
        </div>
      </div>
    )
  }

  const obj = objects[selection[0]]
  if (!obj) return null
  const reviewable = (obj.asset.state === 'generated' || obj.asset.state === 'uploaded') && !obj.asset.approved

  return (
    <div className="panel inspector">
      <div className="panel-title">Inspector</div>
      <div className="obj-head">
        <div className="obj-name">{obj.name}</div>
        <div className="obj-sub">
          {obj.type}
          {obj.tier ? ` · ${obj.tier}` : ''}
          {obj.locked ? ' · 🔒 locked' : ''}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Asset</div>
        <div className="asset-state">
          <span className={`badge badge-${obj.asset.state}`}>{STATE_LABEL[obj.asset.state]}</span>
          {!obj.asset.approved && <span className="badge badge-warn">needs review</span>}
        </div>
        <div className="muted small">License: {obj.asset.license}</div>
        {reviewable && (
          <div className="review-row">
            <button className="wide approve" onClick={() => { s().setApproved(obj.id, true); s().showToast('Approved ✓') }}>
              ✓ Approve
            </button>
            <button
              className="wide"
              onClick={() =>
                s().swapAsset(obj.id, { state: 'procedural', provider: 'procedural', license: 'generated-internal', approved: true })
              }
            >
              ↩ Revert
            </button>
          </div>
        )}
      </div>

      {obj.locked && obj.type === 'road' && (
        <div className="section note">
          Roads are generated procedurally from map data to a driving-grade standard and are
          locked — they're never AI-generated or hand-moved.
        </div>
      )}

      {Object.entries(obj.meta).filter(([, v]) => v !== undefined && v !== '').length > 0 && (
        <div className="section">
          <div className="section-title">Properties</div>
          {Object.entries(obj.meta)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => (
              <div className="kv" key={k}>
                <span>{k}</span>
                <span>{String(v)}</span>
              </div>
            ))}
        </div>
      )}

      <ResolutionSection obj={obj} />
      <ReferenceSection obj={obj} />
      {!obj.locked && <TransformEditor obj={obj} />}
      {(obj.type === 'building' || replaceables.has(obj.id)) && !obj.deleted && (
        <ReplacePanel obj={obj} />
      )}

      <div className="section">
        <button className="wide" onClick={() => frameObjects([obj.id])}>⌖ Frame object (F)</button>
      </div>
    </div>
  )
}
