import { useEffect, useRef, useState } from 'react'
import type { ObjectType, SceneObject } from '../types'
import { useEditor } from '../state/store'
import { PROVIDERS, runGeneration, uploadModel } from '../gateway/providers'
import {
  replaceWithSketchfab,
  searchSketchfab,
  sketchfabAvailable,
  type SketchfabModel,
} from '../gateway/sketchfab'
import { buildingPlans } from '../scene/registry'

// Seed the Sketchfab query from what the object is, so the first search is
// already relevant. Poly budget is per object type — a dense city needs cheap
// street furniture but tolerates richer hero props.
function defaultQuery(obj: SceneObject): string {
  // Buildings: use the recognizer's descriptor-derived query (style + type).
  const plan = buildingPlans.get(obj.id)
  if (plan) return plan.sketchfabQuery
  const byType: Partial<Record<ObjectType, string>> = {
    building: 'building',
    'traffic-signal': 'traffic light',
    vegetation: 'tree',
    'street-furniture': 'street furniture',
  }
  const kind = (obj.meta?.kind as string) || ''
  if (kind) return kind.replace(/_/g, ' ')
  return byType[obj.type] || obj.name || 'prop'
}

function polyBudget(obj: SceneObject): number {
  switch (obj.type) {
    case 'building':
      return 120000
    case 'traffic-signal':
      return 9000
    case 'vegetation':
      return 6000
    default:
      return obj.tier === 'landmark' ? 60000 : 15000
  }
}

/** Per-object provider menu (PRD §9.2) — buildings & wikidata props, never roads. */
export function ReplacePanel({ obj }: { obj: SceneObject }) {
  const job = useEditor((s) => s.jobs[obj.id])
  const fileRef = useRef<HTMLInputElement>(null)
  const s = useEditor.getState

  const [panel, setPanel] = useState<'menu' | 'sketchfab'>('menu')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SketchfabModel[]>([])
  const [searching, setSearching] = useState(false)
  const [sfReady, setSfReady] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeProvider =
    obj.asset.state === 'procedural' ? 'procedural' : obj.asset.provider

  // reset to the menu whenever the selected object changes
  useEffect(() => {
    setPanel('menu')
    setResults([])
    setError(null)
    setQuery(defaultQuery(obj))
  }, [obj.id])

  const openSketchfab = async () => {
    if (job) return
    setPanel('sketchfab')
    if (sfReady === null) {
      const ok = await sketchfabAvailable()
      setSfReady(ok)
      if (ok) runSearch(defaultQuery(obj))
    } else if (sfReady) {
      runSearch(query || defaultQuery(obj))
    }
  }

  const runSearch = async (q: string) => {
    if (!q.trim()) return
    setSearching(true)
    setError(null)
    try {
      const r = await searchSketchfab(q, { maxFaces: polyBudget(obj) })
      setResults(r)
      if (!r.length) setError('No downloadable, permissively-licensed models under the poly budget. Try another term.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const plan = buildingPlans.get(obj.id)

  // One-click "do the recognizer's recommended thing": generate from the
  // reference photo when one exists, else seed a Sketchfab search with the
  // descriptor query. Both are conditioned on the same recognizer prompt.
  const autoFill = () => {
    if (job || !plan) return
    if (plan.recommendedUpgrade === 'photo-generate') runGeneration(obj.id, 'trellis-local')
    else openSketchfab()
  }

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
      case 'sketchfab':
        openSketchfab()
        break
      case 'upload':
        fileRef.current?.click()
        break
    }
  }

  return (
    <div className="replace-panel">
      {plan && panel === 'menu' && (
        <div className="recognizer-block">
          <div className="section-title">🔎 Building Recognizer</div>
          <div className="rec-desc">
            <span className="rec-style">{plan.descriptor.style.replace(/-/g, ' ')}</span>
            <span className={`conf conf-${plan.confidence >= 0.7 ? 'high' : plan.confidence >= 0.5 ? 'mid' : 'low'}`}>
              {Math.round(plan.confidence * 100)}%
            </span>
          </div>
          <div className="rec-facts">
            {plan.descriptor.material} · {plan.descriptor.roofForm} roof · {plan.descriptor.floors} floors · {plan.descriptor.era}
            {plan.descriptor.features.length ? ` · ${plan.descriptor.features.join(', ')}` : ''}
          </div>
          <div className="rec-prompt">“{plan.descriptor.prompt}”</div>
          <button className="wide primary" disabled={!!job} onClick={autoFill}>
            {plan.recommendedUpgrade === 'photo-generate'
              ? '✨ Auto-fill: generate from reference photo'
              : '✨ Auto-fill: find a match on Sketchfab'}
          </button>
          <div className="section-hint">
            {plan.descriptor.source === 'vlm'
              ? 'Descriptor from a vision-language model.'
              : plan.recommendedUpgrade === 'photo-generate'
                ? 'Descriptor from structured priors — a reference photo is available to upgrade via a VLM/generation.'
                : 'Descriptor synthesized from OSM + region priors (no photo). Configure a VLM endpoint for image-grounded recognition.'}
          </div>
        </div>
      )}

      <div className="section-title">Replace this object</div>
      <div className="section-hint">
        The slot (position, footprint, height) stays fixed — any source is fitted into it.
      </div>

      {panel === 'menu' &&
        PROVIDERS.map((p) => (
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

      {panel === 'sketchfab' && (
        <div className="sf-search">
          <button className="sf-back" onClick={() => setPanel('menu')}>
            ← Back to sources
          </button>

          {sfReady === false ? (
            <div className="section-hint">
              🔒 Sketchfab search needs the dev proxy running (a{' '}
              <code>SKETCHFAB_API_TOKEN</code> in <code>.env</code> and{' '}
              <code>npm run dev</code>). A static build needs a small backend proxy —
              see the PRD.
            </div>
          ) : (
            <>
              <form
                className="sf-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  runSearch(query)
                }}
              >
                <input
                  className="sf-input"
                  value={query}
                  placeholder="Search Sketchfab…"
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
                <button className="sf-go" type="submit" disabled={searching}>
                  {searching ? '…' : 'Search'}
                </button>
              </form>
              <div className="section-hint">
                Downloadable · CC0 / CC-BY / CC-BY-SA · under {polyBudget(obj).toLocaleString()} tris.
              </div>

              {error && <div className="sf-error">{error}</div>}

              {searching && !results.length && (
                <div className="job-row">
                  <div className="spinner small" />
                  <div className="job-info">Searching Sketchfab…</div>
                </div>
              )}

              <div className="sf-grid">
                {results.map((m) => (
                  <button
                    key={m.uid}
                    className="sf-card"
                    disabled={!!job}
                    title={`${m.name} — ${m.license} by ${m.author}`}
                    onClick={() => replaceWithSketchfab(obj.id, m)}
                  >
                    {m.thumbnail ? (
                      <img className="sf-thumb" src={m.thumbnail} alt={m.name} loading="lazy" />
                    ) : (
                      <div className="sf-thumb sf-thumb-empty">no preview</div>
                    )}
                    <div className="sf-card-name">{m.name}</div>
                    <div className="sf-card-meta">
                      <span>{(m.faceCount / 1000).toFixed(1)}k tris</span>
                      <span className="sf-lic">{m.licenseSlug.toUpperCase()}</span>
                    </div>
                    <div className="sf-card-author">by {m.author}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

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
