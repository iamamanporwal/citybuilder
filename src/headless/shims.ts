// Minimal DOM shims so the generation + export pipeline runs in plain Node
// (CLI / serverless API). Import this module FIRST — procgen/materials.ts
// draws canvas textures at module-load time, so the shims must be installed
// before any scene module is evaluated.
//
// What needs shimming (and nothing more):
//  - document.createElement('canvas')  → procgen/materials, procgen/signs,
//    materials/textures draw facade/sign/PBR textures on 2D canvases
//  - HTMLCanvasElement + canvas.toBlob → GLTFExporter serialises CanvasTexture
//    images via instanceof checks and toBlob
//  - FileReader + ImageData           → GLTFExporter binary path
//
// Backed by @napi-rs/canvas (prebuilt Skia, no system deps) so headless
// exports carry the same real textures as the in-browser export.

import { Canvas, ImageData, createCanvas } from '@napi-rs/canvas'

declare global {
  // eslint-disable-next-line no-var
  var __cbHeadless: boolean | undefined
}

export function installDomShims(): void {
  if (typeof document !== 'undefined') return // real browser — nothing to do
  const g = globalThis as any
  if (g.__cbHeadless) return

  // canvas.toBlob, used by GLTFExporter's getToBlobPromise
  const proto = Canvas.prototype as any
  if (!proto.toBlob) {
    proto.toBlob = function (cb: (b: Blob) => void, type = 'image/png', _quality?: number) {
      const mime = type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      cb(new Blob([this.toBuffer(mime)], { type: mime }))
    }
  }

  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') {
        throw new Error(`headless document shim: only <canvas> is supported, got <${tag}>`)
      }
      const c = createCanvas(1, 1)
      // @napi-rs/canvas exposes a .data() METHOD; GLTFExporter probes
      // `image.data !== undefined` to detect raw-pixel images and would read
      // garbage off the function instead of calling drawImage. Shadow it.
      Object.defineProperty(c, 'data', { value: undefined })
      return c
    },
  }
  g.HTMLCanvasElement = Canvas // GLTFExporter: image instanceof HTMLCanvasElement
  if (!g.ImageData) g.ImageData = ImageData

  if (!g.FileReader) {
    g.FileReader = class FileReaderShim {
      result: ArrayBuffer | string | null = null
      onloadend: (() => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      readAsArrayBuffer(blob: Blob) {
        blob.arrayBuffer().then(
          (buf) => {
            this.result = buf
            this.onloadend?.()
          },
          (e) => this.onerror?.(e),
        )
      }
      readAsDataURL(blob: Blob) {
        blob.arrayBuffer().then(
          (buf) => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
            this.onloadend?.()
          },
          (e) => this.onerror?.(e),
        )
      }
    }
  }

  g.__cbHeadless = true
}

installDomShims()
