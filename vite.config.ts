import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

// Sketchfab integration keeps the API token server-side (PRD §7D):
//  - /api/sketchfab/*      → api.sketchfab.com/v3/*  with the token injected
//    into the Authorization header here, so it never enters the client bundle.
//  - /api/sketchfab-dl?url= → server-side fetch of a model's presigned S3
//    download URL, streamed back. A path-rewriting proxy corrupts the AWS
//    signature (URL-encoding drift → 403), so this is a fetch-and-pipe
//    middleware that passes the signed URL through byte-for-byte.
//
// Production note: a static build has no dev server — the in-app Sketchfab
// search needs an equivalent backend/serverless proxy. Until then the feature
// is dev-only and degrades gracefully (the provider probes /api/sketchfab/me
// and disables itself if the proxy is absent).
function sketchfabDownload(): Plugin {
  const ALLOWED = ['sketchfab.com', 'amazonaws.com']
  return {
    name: 'sketchfab-download',
    configureServer(server) {
      server.middlewares.use('/api/sketchfab-dl', async (req, res) => {
        try {
          const target = new URL(req.originalUrl || req.url || '', 'http://x').searchParams.get('url')
          if (!target) { res.statusCode = 400; return res.end('missing url') }
          const host = new URL(target).hostname
          if (!ALLOWED.some((d) => host === d || host.endsWith(`.${d}`))) {
            res.statusCode = 400
            return res.end('host not allowed')
          }
          const upstream = await fetch(target) // exact signed URL, no auth header
          res.statusCode = upstream.status
          res.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream')
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (e) {
          res.statusCode = 502
          res.end(`download proxy error: ${(e as Error).message}`)
        }
      })
    },
  }
}

// Serve the repo asset library (assets/library/**) at /assetlib/** so the
// runtime scene builder can load library GLBs by URL. Kept out of /public to
// avoid duplicating ~250 MB; served directly from the repo in dev. A static
// production build must publish assets/library alongside dist (documented).
function assetLibrary(): Plugin {
  const MIME: Record<string, string> = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.hdr': 'image/vnd.radiance',
  }
  const ROOT = join(process.cwd(), 'assets', 'library')
  return {
    name: 'asset-library',
    configureServer(server) {
      server.middlewares.use('/assetlib', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url || '').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
        const file = join(ROOT, rel)
        if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('content-type', MIME[extname(file).toLowerCase()] || 'application/octet-stream')
        res.setHeader('cache-control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const token = env.SKETCHFAB_API_TOKEN || ''

  return {
    plugins: [react(), sketchfabDownload(), assetLibrary()],
    build: {
      chunkSizeWarningLimit: 2000,
    },
    server: {
      proxy: {
        '/api/sketchfab': {
          target: 'https://api.sketchfab.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/sketchfab/, '/v3'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (token) proxyReq.setHeader('Authorization', `Token ${token}`)
            })
          },
        },
      },
    },
  }
})
