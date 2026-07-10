import { create } from 'zustand'
import type {
  AssetInfo,
  CameraMode,
  CityGraph,
  GenerationJob,
  GizmoMode,
  ProviderId,
  SceneObject,
  Transform,
} from '../types'
import { buildScene } from '../scene/registry'
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
  cameraMode: CameraMode
  gizmoMode: GizmoMode
  snapping: boolean
  gizmoDragging: boolean
  sunTime: number
  fxPreview: boolean
  contextInfo: ContextInfo | null
  lintReport: LintWarning[]
  helpOpen: boolean
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
  setLintReport: (w: LintWarning[]) => void
  select: (ids: string[], additive?: boolean) => void
  clearSelection: () => void
  setCameraMode: (m: CameraMode) => void
  setGizmoMode: (m: GizmoMode) => void
  setSnapping: (v: boolean) => void
  setGizmoDragging: (v: boolean) => void
  setSunTime: (t: number) => void
  setHelpOpen: (v: boolean) => void
  setFilterAsset: (f: AssetFilter) => void
  setSearch: (s: string) => void
  showToast: (msg: string) => void
  updateObject: (id: string, patch: Partial<SceneObject>) => void
  commitTransform: (id: string, before: Transform, after: Transform) => void
  setTransformDirect: (id: string, t: Transform) => void
  swapAsset: (id: string, after: AssetInfo, opts?: { skipUndo?: boolean }) => void
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
  }
  return { objects }
}

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
  cameraMode: 'orbit',
  gizmoMode: 'translate',
  snapping: true,
  gizmoDragging: false,
  sunTime: 14,
  fxPreview: false,
  contextInfo: null,
  lintReport: [],
  helpOpen: false,
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
  clearSelection: () => set({ selection: [] }),

  setCameraMode: (m) => set({ cameraMode: m }),
  setGizmoMode: (m) => set({ gizmoMode: m }),
  setSnapping: (v) => set({ snapping: v }),
  setGizmoDragging: (v) => set({ gizmoDragging: v }),
  setSunTime: (t) => set({ sunTime: t }),
  setHelpOpen: (v) => set({ helpOpen: v }),
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
