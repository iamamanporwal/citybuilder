import { Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, Center, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useEditor } from '../state/store'
import { curationCandidates, type CurationCandidate } from '../resolver/assetPools'

// ---------------------------------------------------------------------------
// Curate Asset Library — a visual studio to hand-pick the best 3D model
// variant(s) for each thing (vegetation, benches, lamps, buildings…). Left: the
// procedural baseline. Right: candidate models you can multi-select (variety, so
// not every instance is identical). Each card shows the essentials for judging
// how lightweight + engine-compatible a model is: triangles, file size,
// real-world dimensions, material/texture counts. "Apply" downloads your picks
// as a JSON data file to hand back for baking a leaner curated library.
// ---------------------------------------------------------------------------

const fmtBytes = (b: number) => (b >= 1_048_576 ? (b / 1_048_576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB')
const fmtTris = (t: number) => (t >= 1000 ? (t / 1000).toFixed(1) + 'k' : String(t))
const fmtDims = (d: CurationCandidate['dims']) => (d ? `${d.x.toFixed(1)}×${d.y.toFixed(1)}×${d.z.toFixed(1)} m` : '—')
const WEIGHT_BADGE = { light: '🟢 light', medium: '🟡 medium', heavy: '🔴 heavy' } as const

function PreviewModel({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const cloned = useMemo(() => scene.clone(true), [scene])
  return (
    <Bounds fit clip observe margin={1.2}>
      <Center>
        <primitive object={cloned} />
      </Center>
    </Bounds>
  )
}

function Preview({ url }: { url: string | null }) {
  return (
    <div className="cur-preview">
      <Canvas camera={{ position: [3, 2.4, 3.4], fov: 45 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={['#12151a']} />
        <ambientLight intensity={0.7} />
        <hemisphereLight args={['#cfe0f0', '#3a3f36', 0.6]} />
        <directionalLight position={[5, 8, 5]} intensity={1.3} />
        <gridHelper args={[10, 10, '#2a2f38', '#1c2027']} />
        {url && (
          <Suspense fallback={null}>
            <PreviewModel url={url} key={url} />
          </Suspense>
        )}
        <OrbitControls autoRotate autoRotateSpeed={1.5} enablePan={false} minDistance={1.5} maxDistance={40} />
      </Canvas>
      {!url && <div className="cur-preview-empty">Hover a model to preview it</div>}
    </div>
  )
}

export function CurationStudio() {
  const open = useEditor((s) => s.curationOpen)
  const setOpen = useEditor((s) => s.setCurationOpen)
  const kinds = useMemo(() => (open ? curationCandidates() : []), [open])
  const [activeKind, setActiveKind] = useState<string>('')
  const [preview, setPreview] = useState<string | null>(null)
  // selection: kind → Set<assetId>. Initialized to the recommended (light) picks.
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map())

  useEffect(() => {
    if (!open || !kinds.length) return
    setActiveKind((k) => k || kinds[0].kind)
    setSelected((prev) => {
      if (prev.size) return prev
      const init = new Map<string, Set<string>>()
      for (const k of kinds) init.set(k.kind, new Set(k.candidates.filter((c) => c.recommended).map((c) => c.id)))
      return init
    })
  }, [open, kinds])

  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [open, setOpen])

  if (!open) return null
  const active = kinds.find((k) => k.kind === activeKind) ?? kinds[0]
  const activeSel = selected.get(active?.kind) ?? new Set<string>()
  const totalSelected = [...selected.values()].reduce((n, s) => n + s.size, 0)

  const toggle = (kind: string, id: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(kind) ?? [])
      set.has(id) ? set.delete(id) : set.add(id)
      next.set(kind, set)
      return next
    })

  const apply = () => {
    const byId = new Map(kinds.flatMap((k) => k.candidates.map((c) => [c.id, { kind: k.kind, c }] as const)))
    const selections: Record<string, unknown[]> = {}
    for (const [kind, ids] of selected) {
      if (!ids.size) continue
      selections[kind] = [...ids].map((id) => {
        const c = byId.get(id)!.c
        return {
          id: c.id, name: c.name, url: c.url, role: c.role, semantic: c.semantic,
          osmTags: c.osmTags, triangles: c.triangles, bytes: c.bytes, dims: c.dims,
          materials: c.materials, textures: c.textures, weightClass: c.weightClass,
          source: c.source, license: c.license,
        }
      })
    }
    const payload = {
      schema: 'citybuilder.curation/v1',
      generatedAt: new Date().toISOString(),
      totalSelected,
      note: 'Hand back to Claude to bake a curated asset library from exactly these picks.',
      selections,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'asset-curation.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  return (
    <div className="cur-overlay">
      <div className="cur-header">
        <div>
          <div className="cur-title">🎛️ Curate Asset Library</div>
          <div className="cur-sub">Pick the best model variant(s) per thing — lighter + engine-compatible wins. {totalSelected} selected.</div>
        </div>
        <div className="cur-header-actions">
          <button className="cur-apply" onClick={apply} disabled={!totalSelected}>⬇ Apply · export {totalSelected}</button>
          <button className="cur-close" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
        </div>
      </div>

      <div className="cur-body">
        {/* left rail: kinds */}
        <div className="cur-rail">
          {kinds.map((k) => {
            const sel = selected.get(k.kind)?.size ?? 0
            return (
              <button
                key={k.kind}
                className={k.kind === active?.kind ? 'cur-rail-item active' : 'cur-rail-item'}
                onClick={() => { setActiveKind(k.kind); setPreview(null) }}
              >
                <span className="cur-rail-label">{k.label}</span>
                <span className="cur-rail-count">{sel}/{k.candidates.length}</span>
              </button>
            )
          })}
        </div>

        {/* procedural baseline (left) */}
        <div className="cur-baseline">
          <div className="cur-col-title">Procedural (current)</div>
          <div className="cur-baseline-card">
            <div className="cur-baseline-icon">{active?.label.split(' ')[0]}</div>
            <div className="cur-baseline-desc">{active?.procedural}</div>
            <div className="cur-baseline-note">This is what the city uses today. Pick models on the right to add real 3D variety — multiple picks = varied instances, not the same model everywhere.</div>
          </div>
          <Preview url={preview} />
        </div>

        {/* candidates (right) */}
        <div className="cur-candidates">
          <div className="cur-col-title">
            Models — choose any ({active?.candidates.length ?? 0} candidates, sorted lightest first)
          </div>
          <div className="cur-grid">
            {active?.candidates.map((c) => {
              const on = activeSel.has(c.id)
              return (
                <div
                  key={c.id}
                  className={on ? 'cur-card on' : 'cur-card'}
                  onClick={() => toggle(active.kind, c.id)}
                  onMouseEnter={() => setPreview(c.url)}
                >
                  <div className="cur-card-head">
                    <span className="cur-card-name" title={c.name}>{c.name}</span>
                    {c.recommended && <span className="cur-star" title="Recommended (lightweight)">★</span>}
                    <span className={on ? 'cur-check on' : 'cur-check'}>{on ? '✓' : ''}</span>
                  </div>
                  <div className="cur-stats">
                    <span title="Triangle count">▲ {fmtTris(c.triangles)}</span>
                    <span title="File size">💾 {fmtBytes(c.bytes)}</span>
                    <span title="Weight class">{WEIGHT_BADGE[c.weightClass]}</span>
                  </div>
                  <div className="cur-stats muted">
                    <span title="Dimensions W×H×D">📐 {fmtDims(c.dims)}</span>
                    <span title="Materials · textures">🎨 {c.materials}m/{c.textures}t</span>
                  </div>
                  {c.flags.includes('oversized') && <div className="cur-flag">⚠ non-metric — auto-rescaled to real size on placement</div>}
                  <div className="cur-src">{c.license} · {c.source.split('—')[0].trim()}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
