import { useMemo, useState } from 'react'
import { useEditor, type AssetFilter } from '../state/store'
import type { ObjectType, SceneObject } from '../types'
import { frameObjects } from '../editor/actions'

const GROUPS: { key: ObjectType[]; label: string; icon: string; defaultOpen: boolean }[] = [
  { key: ['building'], label: 'Buildings', icon: '🏢', defaultOpen: true },
  { key: ['road', 'sidewalks', 'markings', 'bridge-structure'], label: 'Road network (locked)', icon: '🛣️', defaultOpen: false },
  { key: ['traffic-signal', 'street-furniture'], label: 'Street furniture & props', icon: '🚦', defaultOpen: false },
  { key: ['vegetation'], label: 'Vegetation', icon: '🌳', defaultOpen: false },
  { key: ['ground', 'area'], label: 'Terrain & water', icon: '⛰️', defaultOpen: false },
]

const TIER_BADGE: Record<string, string> = { landmark: '★', notable: '◆', generic: '' }

function provenanceDot(o: SceneObject): { cls: string; label: string } {
  switch (o.asset.state) {
    case 'generated':
      return { cls: o.asset.approved ? 'dot-gen' : 'dot-gen dot-unapproved', label: 'AI-generated' }
    case 'uploaded':
      return { cls: o.asset.approved ? 'dot-up' : 'dot-up dot-unapproved', label: 'Uploaded' }
    case 'library':
      return { cls: 'dot-lib', label: 'Library' }
    default:
      return { cls: 'dot-proc', label: 'Procedural' }
  }
}

export function Hierarchy() {
  const objects = useEditor((s) => s.objects)
  const order = useEditor((s) => s.objectOrder)
  const selection = useEditor((s) => s.selection)
  const search = useEditor((s) => s.search)
  const filterAsset = useEditor((s) => s.filterAsset)
  const s = useEditor.getState
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(GROUPS.map((g) => [g.label, g.defaultOpen])),
  )

  const selectionSet = useMemo(() => new Set(selection), [selection])

  const matches = (o: SceneObject) => {
    if (o.deleted) return false
    if (search && !o.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterAsset === 'unapproved') return !o.asset.approved
    if (filterAsset !== 'all' && o.asset.state !== filterAsset) return false
    return true
  }

  const grouped = useMemo(() => {
    const m = new Map<string, SceneObject[]>()
    for (const g of GROUPS) m.set(g.label, [])
    for (const id of order) {
      const o = objects[id]
      if (!o || !matches(o)) continue
      const g = GROUPS.find((g) => g.key.includes(o.type))
      if (g) m.get(g.label)!.push(o)
    }
    // buildings: landmarks first, then notable, then generic
    const tierRank = { landmark: 0, notable: 1, generic: 2 }
    m.get('Buildings')?.sort((a, b) => (tierRank[a.tier ?? 'generic'] - tierRank[b.tier ?? 'generic']) || a.name.localeCompare(b.name))
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, order, search, filterAsset])

  return (
    <div className="panel hierarchy">
      <div className="panel-title">Scene</div>
      <input
        className="search"
        placeholder="🔍 Search objects…"
        value={search}
        onChange={(e) => s().setSearch(e.target.value)}
      />
      <select
        className="filter"
        value={filterAsset}
        onChange={(e) => s().setFilterAsset(e.target.value as AssetFilter)}
        title="Filter by asset provenance — review AI results with 'Not yet approved'"
      >
        <option value="all">All assets</option>
        <option value="procedural">Procedural only</option>
        <option value="generated">AI-generated</option>
        <option value="uploaded">Uploaded</option>
        <option value="unapproved">⚠ Not yet approved</option>
      </select>

      <div className="tree">
        {GROUPS.map((g) => {
          const items = grouped.get(g.label) ?? []
          if (!items.length && (search || filterAsset !== 'all')) return null
          // an active search/filter auto-expands groups so matches are visible
          const expanded = open[g.label] || !!search || filterAsset !== 'all'
          return (
            <div key={g.label}>
              <div className="tree-group">
                <button className="tree-caret" onClick={() => setOpen({ ...open, [g.label]: !open[g.label] })}>
                  {open[g.label] ? '▾' : '▸'}
                </button>
                <span
                  className="tree-group-label"
                  title="Click to select all in this group"
                  onClick={() => s().select(items.map((i) => i.id))}
                >
                  {g.icon} {g.label} <span className="count">{items.length}</span>
                </span>
              </div>
              {expanded &&
                items.map((o) => {
                  const dot = provenanceDot(o)
                  return (
                    <div
                      key={o.id}
                      className={`tree-item ${selectionSet.has(o.id) ? 'selected' : ''}`}
                      onClick={(e) => s().select([o.id], e.shiftKey)}
                      onDoubleClick={() => frameObjects([o.id])}
                      title={`${o.name} — ${dot.label}${o.locked ? ' (locked)' : ''}. Double-click to frame.`}
                    >
                      <span className={`dot ${dot.cls}`} />
                      <span className="tree-name">
                        {o.tier && TIER_BADGE[o.tier] ? `${TIER_BADGE[o.tier]} ` : ''}
                        {o.name}
                      </span>
                      {o.locked && <span className="lock">🔒</span>}
                      <button
                        className="eye"
                        title={o.visible ? 'Hide' : 'Show'}
                        onClick={(e) => {
                          e.stopPropagation()
                          s().toggleVisible(o.id)
                        }}
                      >
                        {o.visible ? '👁' : '–'}
                      </button>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      <div className="legend">
        <span><span className="dot dot-proc" /> procedural</span>
        <span><span className="dot dot-gen" /> AI</span>
        <span><span className="dot dot-up" /> uploaded</span>
        <span>★ landmark ◆ notable</span>
      </div>
    </div>
  )
}
