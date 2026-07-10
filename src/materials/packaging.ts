import { TEXTURE_REGISTRY } from './textures'

// Texture packaging policy: consistent texel density + per-LOD budgets.
// In-editor we run raw canvas textures; the export ships a manifest that the
// bake service uses to encode KTX2/Basis at the right codec per map type.

/** World-space size one texture tile covers (drives repeat + texel density). */
export const ROAD_TILE_M = 6
export const FACADE_TILE_M = { w: 3.6, h: 3.2 } // one window bay per tile

/** Target texel densities (px per meter) per LOD. */
export const TEXEL_DENSITY = {
  lod0: 72, // eye-level: 256px tile / ~3.6m bay
  lod1: 36,
  lod2: 18,
}

/** Per-tile texture memory budgets (KTX2-transcoded, per 256m scene tile). */
export const LOD_TEXTURE_BUDGET_MB = {
  lod0: 24,
  lod1: 8,
  lod2: 2,
}

const CODEC_BY_KIND: Record<string, string> = {
  albedo: 'ETC1S (sRGB)', // high compression, color data
  'decal-albedo': 'ETC1S (sRGB, alpha)',
  normal: 'UASTC (linear, RG)', // quality-critical, slope data
  metallicRoughness: 'ETC1S (linear)',
}

export interface TextureManifestEntry {
  name: string
  kind: string
  sizePx: number
  ktx2Codec: string
  colorSpace: 'srgb' | 'linear'
  texelDensityPxPerM: number
  mipLevels: number
}

export function buildTextureManifest() {
  const entries: TextureManifestEntry[] = TEXTURE_REGISTRY.map((t) => ({
    name: t.name,
    kind: t.kind,
    sizePx: t.size,
    ktx2Codec: CODEC_BY_KIND[t.kind] ?? 'ETC1S',
    colorSpace: t.kind === 'albedo' || t.kind === 'decal-albedo' ? 'srgb' : 'linear',
    texelDensityPxPerM: Math.round(t.size / (t.name.startsWith('facade') ? FACADE_TILE_M.w : ROAD_TILE_M)),
    mipLevels: Math.log2(t.size) + 1,
  }))
  return {
    policy: {
      texelDensityTargets: TEXEL_DENSITY,
      perTileBudgetMB: LOD_TEXTURE_BUDGET_MB,
      note: 'Editor runs raw canvas textures; bake service encodes to KTX2/Basis per this manifest. Facade tiles pack into a trim-sheet atlas at bake.',
    },
    textures: entries,
  }
}

/** Export all generated textures as PNG blobs (bake-service input). */
export async function exportTexturePngs(): Promise<{ name: string; blob: Blob }[]> {
  const out: { name: string; blob: Blob }[] = []
  for (const t of TEXTURE_REGISTRY) {
    const blob = await new Promise<Blob | null>((r) => t.canvas.toBlob(r, 'image/png'))
    if (blob) out.push({ name: `${t.name}.png`, blob })
  }
  return out
}
