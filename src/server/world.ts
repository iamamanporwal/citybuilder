// Shared plumbing for the World API (api/v1/maps). Job state and artifacts
// both live in Vercel Blob:
//
//   maps/{id}/manifest.json + GLBs/JSON   — immutable artifacts (CDN-cached)
//   jobs/{id}.json                        — "generation started" marker
//   jobs/{id}.failed.json                 — failure record with the error
//
// Status is derived from which blobs EXIST (via list(), which is never
// CDN-cached) rather than from mutable status fields, so polls are always
// fresh while the heavy artifacts stay cacheable. The job id doubles as the
// deterministic cache key: same bbox + options + contract ⇒ same id ⇒ a
// previously generated map is returned instantly.

import { list, put } from '@vercel/blob'
import { createHash } from 'node:crypto'
import type { BBox } from '../ingest/overpassFetch'

// Bump when the output contract changes so cached maps regenerate.
// w = world-api manifest, s = semanticsVersion, c = collider formatVersion.
export const CONTRACT = 'w1.s3.c2'
export const MANIFEST_VERSION = 1

/** How long a running job may go without finishing before a re-POST restarts it. */
export const JOB_STALE_MS = 15 * 60 * 1000

export interface MapOptions {
  trees: boolean
  signals: boolean
  roadScale: number
  corridorElevation: boolean
  bake: boolean
}

export interface MapRequest {
  bbox: BBox
  name?: string
  options: MapOptions
}

export const DEFAULT_OPTIONS: MapOptions = {
  trees: true,
  signals: true,
  roadScale: 1,
  corridorElevation: true,
  bake: true,
}

export function normalizeRequest(body: any): MapRequest | { error: string } {
  const b = body?.bbox
  if (!b || typeof b !== 'object') return { error: 'body.bbox {south,west,north,east} is required' }
  const bbox: BBox = { south: +b.south, west: +b.west, north: +b.north, east: +b.east }
  const o = body?.options ?? {}
  const options: MapOptions = {
    trees: o.trees ?? DEFAULT_OPTIONS.trees,
    signals: o.signals ?? DEFAULT_OPTIONS.signals,
    roadScale: Number.isFinite(+o.roadScale) ? +o.roadScale : DEFAULT_OPTIONS.roadScale,
    corridorElevation: o.corridorElevation ?? DEFAULT_OPTIONS.corridorElevation,
    bake: o.bake ?? DEFAULT_OPTIONS.bake,
  }
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined
  return { bbox, name, options }
}

/** Deterministic job id: bbox rounded to ~1 m + options + contract version. */
export function mapId(req: MapRequest): string {
  const r = (n: number) => Math.round(n * 1e5) / 1e5
  const key = JSON.stringify({
    contract: CONTRACT,
    bbox: [r(req.bbox.south), r(req.bbox.west), r(req.bbox.north), r(req.bbox.east)],
    o: req.options,
  })
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

// ---- auth + CORS -----------------------------------------------------------

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': process.env.WORLD_API_CORS_ORIGIN ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key',
    'access-control-max-age': '86400',
  }
}

/** Keys come from WORLD_API_KEYS (comma-separated). Unset ⇒ open (dev). */
export function authorized(req: Request): boolean {
  const keys = (process.env.WORLD_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (!keys.length) return true
  return keys.includes(req.headers.get('x-api-key') ?? '')
}

export function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  })
}

// ---- blob-backed job state ---------------------------------------------------

export interface BlobRef {
  url: string
  uploadedAt: Date
}

async function findBlob(pathname: string): Promise<BlobRef | null> {
  const res = await list({ prefix: pathname, limit: 1 })
  const hit = res.blobs.find((b) => b.pathname === pathname)
  return hit ? { url: hit.url, uploadedAt: new Date(hit.uploadedAt) } : null
}

export const manifestPath = (id: string) => `maps/${id}/manifest.json`
export const jobPath = (id: string) => `jobs/${id}.json`
export const failedPath = (id: string) => `jobs/${id}.failed.json`

export type JobStatus =
  | { status: 'ready'; manifest: unknown }
  | { status: 'generating'; startedAt: string; stale: boolean }
  | { status: 'failed'; error: string; failedAt: string }
  | { status: 'unknown' }

export async function jobStatus(id: string): Promise<JobStatus> {
  const manifest = await findBlob(manifestPath(id))
  if (manifest) {
    const res = await fetch(manifest.url)
    return { status: 'ready', manifest: await res.json() }
  }
  const [job, failed] = await Promise.all([findBlob(jobPath(id)), findBlob(failedPath(id))])
  // a job record newer than the failure record means a retry is in flight
  if (job && (!failed || job.uploadedAt > failed.uploadedAt)) {
    return {
      status: 'generating',
      startedAt: job.uploadedAt.toISOString(),
      stale: Date.now() - job.uploadedAt.getTime() > JOB_STALE_MS,
    }
  }
  if (failed) {
    const res = await fetch(failed.url, { cache: 'no-store' })
    const rec = await res.json().catch(() => ({}))
    return { status: 'failed', error: rec.error ?? 'generation failed', failedAt: failed.uploadedAt.toISOString() }
  }
  return { status: 'unknown' }
}

export async function putJson(pathname: string, value: unknown): Promise<string> {
  const blob = await put(pathname, JSON.stringify(value, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  })
  return blob.url
}

export async function putFile(
  pathname: string,
  data: ArrayBuffer | string,
  contentType: string,
): Promise<string> {
  const blob = await put(pathname, typeof data === 'string' ? data : Buffer.from(data), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
  })
  return blob.url
}
