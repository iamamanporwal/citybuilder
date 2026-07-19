import { create } from 'zustand'
import type {
  AssetInfo,
  CameraMode,
  CityGraph,
  GenerationJob,
  GizmoMode,
  ProviderId,
  Quality3d,
  SceneObject,
  Transform,
} from '../types'
import { applyBuildingMaterial, buildScene, currentBuildingMaterial } from '../scene/registry'
import type { BuildingMaterial } from '../scene/registry'
import { loadCuration, saveCuration, type CurationMap } from './curation'
import { setCorridorElevationEnabled } from '../procgen/corridor'
import { setTerrainEnabled } from '../procgen/terrain/config'
import { setRoadStyle, type RoadStyle } from '../materials/library'
import { setPaintWear } from '../procgen/materials'
import { clampRoadScale } from '../procgen/roadScale'
import type { ResolvedContext } from '../resolver/types'
import type { LintWarning } from '../resolver/varietyLint'

export type AssetFilter = 'all' | 'procedural' | 'generated' | 'uploaded' | 'unapproved'

export interface ContextInfo {
  matrixVersion: string
  regionLabel: string
  climate: string
  treePoolSource: string
  landCoverSource: string
  provenance: string[]
}

type Command =
  | { kind: 'transform'; id: string; before: Transform; after: Transform }
  | { kind: 'asset'; id: string; before: AssetInfo; after: AssetInfo }
  | { kind: 'delete'; ids: string[]; deleted: boolean }
  | { kind: 'material'; id: string; before: BuildingMaterial; after: BuildingMaterial }

export type AppPhase = 'picker' | 'building' | 'editor'

interface EditorState {
  appPhase: AppPhase
  buildMessage: string
  loaded: boolean
  loadError: string | null
  cityName: string
  attribution: string
  report: CityGraph['report'] | null
  objects: Record<string, SceneObject>
  objectOrder: string[]
  selection: string[]
  selectedInstance: { objectId: string; index: number; meshUuid: string } | null // per-item pick inside an instanced group
  cameraMode: CameraMode
  gizmoMode: GizmoMode
  snapping: boolean
  gizmoDragging: boolean
  sunTime: number
  fxPreview: boolean
  quality3d: Quality3d
  useLibraryAssets: boolean
  curation: CurationMap
  useCorridorElevation: boolean
  useTerrain: boolean
  roadStyle: RoadStyle
  roadScale: number
  contextInfo: ContextInfo | null
  lintReport: LintWarning[]
  helpOpen: boolean
  curationOpen: boolean
  filterAsset: AssetFilter
  search: string
  toast: string | null
  jobs: Record<string, GenerationJob>
  undoStack: Command[]
  redoStack: Command[]

  initScene: (graph: CityGraph, ctx: ResolvedContext) => void
  openPicker: () => void
  setBuilding: (message: string) => void
  setLoadError: (e: string) => void
  setFxPreview: (v: boolean) => void
  setQuality3d: (v: Quality3d) => void
  setUseLibraryAssets: (v: boolean) => void
  setCuration: (c: CurationMap) => void
  setUseCorridorElevation: (v: boolean) => void
  setUseTerrain: (v: boolean) => void
  setRoadStyle: (v: RoadStyle) => void
  setRoadScale: (v: number) => void
  setLintReport: (w: LintWarning[]) => void
  select: (ids: string[], additive?: boolean) => void
  setSelectedInstance: (v: { objectId: string; index: number; meshUuid: string } | null) => void
  clearSelection: () => void
  setCameraMode: (m: CameraMode) => void
  setGizmoMode: (m: GizmoMode) => void
  setSnapping: (v: boolean) => void
  setGizmoDragging: (v: boolean) => void
  setSunTime: (t: number) => void
  setHelpOpen: (v: boolean) => void
  setCurationOpen: (v: boolean) => void
  setFilterAsset: (f: AssetFilter) => void
  setSearch: (s: string) => void
  showToast: (msg: string) => void
  updateObject: (id: string, patch: Partial<SceneObject>) => void
  commitTransform: (id: string, before: Transform, after: Transform) => void
  setTransformDirect: (id: string, t: Transform) => void
  swapAsset: (id: string, after: AssetInfo, opts?: { skipUndo?: boolean }) => void
  setBuildingMaterial: (id: string, mat: BuildingMaterial) => void
  setApproved: (id: string, approved: boolean) => void
  deleteSelected: () => void
  toggleVisible: (id: string) => void
  undo: () => void
  redo: () => void
  setJob: (job: GenerationJob | null, objectId: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

function applyCommand(state: EditorState, cmd: Command, reverse: boolean): Partial<EditorState> {
  const objects = { ...state.objects }
  switch (cmd.kind) {
    case 'transform': {
      const t = reverse ? cmd.before : cmd.after
      objects[cmd.id] = { ...objects[cmd.id], transform: t }
      break
    }
    case 'asset': {
      const a = reverse ? cmd.before : cmd.after
      objects[cmd.id] = { ...objects[cmd.id], asset: a }
      break
    }
    case 'delete': {
      const del = reverse ? !cmd.deleted : cmd.deleted
      for (const id of cmd.ids) objects[id] = { ...objects[id], deleted: del }
      break
    }
    case 'material': {
      const mat = reverse ? cmd.before : cmd.after
      // side effect: rebuild the building's mesh with the target material set
      applyBuildingMaterial(cmd.id, mat, objects[cmd.id].asset)
      objects[cmd.id] = {
        ...objects[cmd.id],
        meta: { ...objects[cmd.id].meta, facade: mat.facade, roof: mat.roof },
      }
      break
    }
  }
  return { objects }
}

// Loaded once (localStorage or the committed seed). The initial library master
// switch follows it: if the curation has any enabled kind, the curated props are
// live on first load (buildings stay procedural per the seed).
const INITIAL_CURATION = loadCuration()

export const useEditor = create<EditorState>((set, get) => ({
  appPhase: 'picker',
  buildMessage: '',
  loaded: false,
  loadError: null,
  cityName: '',
  attribution: '',
  report: null,
  objects: {},
  objectOrder: [],
  selection: [],
  selectedInstance: null,
  cameraMode: 'orbit',
  gizmoMode: 'translate',
  snapping: true,
  gizmoDragging: false,
  sunTime: 14,
  fxPreview: false,
  // Viewport render quality. 'balanced' matches the original fixed DPR/shadow
  // settings, so the default look is unchanged; Performance/High trade fidelity
  // for framerate (see QUALITY_PRESETS + Viewport).
  quality3d: 'balanced',
  // Master library switch stays OFF by default (procedural-first, PRD §7F). The
  // Curate studio pre-checks the seeded/curated kinds and one "Apply" flips this
  // on and applies the per-kind curation live. Per-kind on/off + model ids live in
  // `curation` (seeded from assets/curation-selection.json → localStorage).
  useLibraryAssets: false,
  curation: INITIAL_CURATION,
  // Network elevation solve (Road Corridor Redesign §6a) — ON by default (E3).
  // Kept in sync with the config module flag (procgen/corridor/config.ts), which
  // also defaults on; the toolbar toggle flips both for instant A/B.
  useCorridorElevation: true,
  // Terrain relief (procgen/terrain) — ON by default (the main map ships with
  // realistic ground). Kept in sync with the config module flag; the toolbar
  // toggle flips both for instant A/B against the flat world.
  useTerrain: true,
  // Road surface style — realistic (textured aggregate) vs arcade (clean kit look).
  roadStyle: 'realistic',
  // Road-width multiplier (car-game "stretch roads" trigger, §14). 1 = original.
  roadScale: 1,
  contextInfo: null,
  lintReport: [],
  helpOpen: false,
  curationOpen: false,
  filterAsset: 'all',
  search: '',
  toast: null,
  jobs: {},
  undoStack: [],
  redoStack: [],

  initScene: (graph, ctx) => {
    const list = buildScene(graph, ctx)
    const objects: Record<string, SceneObject> = {}
    const order: string[] = []
    for (const o of list) {
      objects[o.id] = o
      order.push(o.id)
    }
    set({
      appPhase: 'editor',
      contextInfo: {
        matrixVersion: ctx.matrixVersion,
        regionLabel: ctx.region.label,
        climate: ctx.climate,
        treePoolSource: ctx.treePoolSource,
        landCoverSource: ctx.landCoverSource,
        provenance: ctx.provenance,
      },
      loaded: true,
      loadError: null,
      cityName: graph.cityName,
      attribution: `${graph.attribution} (${graph.license})`,
      report: graph.report,
      objects,
      objectOrder: order,
      selection: [],
      selectedInstance: null,
      undoStack: [],
      redoStack: [],
      jobs: {},
      cameraMode: 'orbit',
      search: '',
      filterAsset: 'all',
    })
  },

  openPicker: () => set({ appPhase: 'picker', loadError: null }),
  setBuilding: (message) => set({ appPhase: 'building', buildMessage: message, loadError: null }),

  setLoadError: (e) => set({ loadError: e, appPhase: 'picker' }),
  setFxPreview: (v) => set({ fxPreview: v }),
  setQuality3d: (v) => set({ quality3d: v }),
  setUseLibraryAssets: (v) => set({ useLibraryAssets: v }),
  setCuration: (c) => { saveCuration(c); set({ curation: c }) },
  setUseCorridorElevation: (v) => {
    setCorridorElevationEnabled(v)
    set({ useCorridorElevation: v })
  },
  setUseTerrain: (v) => {
    setTerrainEnabled(v)
    set({ useTerrain: v })
  },
  setRoadStyle: (v) => {
    setRoadStyle(v)
    setPaintWear(v === 'arcade' ? 0 : 1)
    set({ roadStyle: v })
  },
  setRoadScale: (v) => set({ roadScale: clampRoadScale(v) }),
  setLintReport: (w) => set({ lintReport: w }),

  select: (ids, additive = false) => {
    const cur = get().selection
    if (additive) {
      const next = new Set(cur)
      for (const id of ids) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      set({ selection: [...next] })
    } else {
      set({ selection: ids })
    }
  },
  setSelectedInstance: (v) => set({ selectedInstance: v }),
  clearSelection: () => set({ selection: [], selectedInstance: null }),

  setCameraMode: (m) => set({ cameraMode: m }),
  setGizmoMode: (m) => set({ gizmoMode: m }),
  setSnapping: (v) => set({ snapping: v }),
  setGizmoDragging: (v) => set({ gizmoDragging: v }),
  setSunTime: (t) => set({ sunTime: t }),
  setHelpOpen: (v) => set({ helpOpen: v }),
  setCurationOpen: (v) => set({ curationOpen: v }),
  setFilterAsset: (f) => set({ filterAsset: f }),
  setSearch: (s) => set({ search: s }),

  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: msg })
    toastTimer = setTimeout(() => set({ toast: null }), 3500)
  },

  updateObject: (id, patch) =>
    set((s) => ({ objects: { ...s.objects, [id]: { ...s.objects[id], ...patch } } })),

  commitTransform: (id, before, after) => {
    const cmd: Command = { kind: 'transform', id, before, after }
    set((s) => ({
      ...applyCommand(s, cmd, false),
      undoStack: [...s.undoStack, cmd].slice(-100),
      redoStack: [],
    }))
  },

  setTransformDirect: (id, t) =>
    set((s) => ({ objects: { ...s.objects, [id]: { ...s.objects[id], transform: t } } })),

  swapAsset: (id, after, opts) => {
    const before = get().objects[id].asset
    const cmd: Command = { kind: 'asset', id, before, after }
    set((s) => ({
      ...applyCommand(s, cmd, false),
      undoStack: opts?.skipUndo ? s.undoStack : [...s.undoStack, cmd].slice(-100),
      redoStack: opts?.skipUndo ? s.redoStack : [],
    }))
  },

  setBuildingMaterial: (id, mat) => {
    const before = currentBuildingMaterial(id)
    if (!before) return // not a re-skinnable procedural building
    if (before.facade === mat.facade && before.roof === mat.roof && before.tint === mat.tint) return
    const cmd: Command = { kind: 'material', id, before, after: mat }
    set((s) => ({
      ...applyCommand(s, cmd, false),
      undoStack: [...s.undoStack, cmd].slice(-100),
      redoStack: [],
    }))
  },

  setApproved: (id, approved) =>
    set((s) => ({
      objects: {
        ...s.objects,
        [id]: { ...s.objects[id], asset: { ...s.objects[id].asset, approved } },
      },
    })),

  deleteSelected: () => {
    const sel = get().selection.filter((id) => {
      const o = get().objects[id]
      return o && !o.locked
    })
    if (!sel.length) {
      get().showToast('Nothing deletable selected (roads and terrain are locked)')
      return
    }
    const cmd: Command = { kind: 'delete', ids: sel, deleted: true }
    set((s) => ({
      ...applyCommand(s, cmd, false),
      selection: [],
      selectedInstance: null,
      undoStack: [...s.undoStack, cmd].slice(-100),
      redoStack: [],
    }))
    get().showToast(`Deleted ${sel.length} object(s) — Ctrl+Z to undo`)
  },

  toggleVisible: (id) =>
    set((s) => ({
      objects: { ...s.objects, [id]: { ...s.objects[id], visible: !s.objects[id].visible } },
    })),

  undo: () => {
    const s = get()
    const cmd = s.undoStack[s.undoStack.length - 1]
    if (!cmd) return
    set({
      ...applyCommand(s, cmd, true),
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, cmd],
    })
  },
  redo: () => {
    const s = get()
    const cmd = s.redoStack[s.redoStack.length - 1]
    if (!cmd) return
    set({
      ...applyCommand(s, cmd, false),
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, cmd],
    })
  },

  setJob: (job, objectId) =>
    set((s) => {
      const jobs = { ...s.jobs }
      if (job) jobs[objectId] = job
      else delete jobs[objectId]
      return { jobs }
    }),
}))
