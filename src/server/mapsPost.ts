// POST /api/v1/maps — request a map for a bbox. Returns the job id (a
// deterministic cache key) immediately; generation runs in the background via
// waitUntil. Re-POSTing the same bbox+options returns the cached result.
//
// Bundled to api/v1/maps/index.mjs by tools/build-api.mjs — Vercel's per-file
// TS transpile can't follow this repo's extensionless ESM imports, so each
// endpoint ships as one self-contained esbuild bundle.

import { waitUntil } from '@vercel/functions'
import { validateBBox } from '../headless/generate'
import {
  authorized,
  corsHeaders,
  DEFAULT_OPTIONS,
  jobPath,
  jobStatus,
  json,
  mapId,
  normalizeRequest,
  putJson,
} from './world'
import { runJob } from './runJob'

export const maxDuration = 300 // Overpass fetch + build + bake + upload

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'missing or invalid x-api-key' })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'body must be JSON', example: { bbox: { south: 50.084, west: 14.402, north: 50.092, east: 14.42 }, options: DEFAULT_OPTIONS } })
  }
  const req = normalizeRequest(body)
  if ('error' in req) return json(400, { error: req.error })
  const bad = validateBBox(req.bbox)
  if (bad) return json(400, { error: bad })

  const id = mapId(req)
  const status = await jobStatus(id)

  if (status.status === 'ready') {
    return json(200, { id, status: 'ready', manifest: status.manifest })
  }
  if (status.status === 'generating' && !status.stale) {
    return json(202, { id, status: 'generating', startedAt: status.startedAt, poll: `/api/v1/maps/${id}` })
  }

  // new job (or retry of a failed/stale one)
  await putJson(jobPath(id), { id, startedAt: new Date().toISOString(), request: req })
  waitUntil(runJob(id, req))
  return json(202, { id, status: 'generating', poll: `/api/v1/maps/${id}` })
}
