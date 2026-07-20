import * as THREE from 'three'
import type { FacadeSet, RoadSurfaceSet, RoofSet } from '../resolver/types'
import {
  generateFacadeTextures,
  generateRoofTextures,
  generateSurfaceTextures,
  makeDecals,
  makeDetailNormal,
} from './textures'
import { FACADE_TILE_M, ROAD_TILE_M } from './packaging'

// PBR (metallic-roughness) material library. Materials are UNLIT-authored:
// standard PBR params only — no emissive hacks, no baked light. The editor
// previews them lit; the export carries clean PBR for the game engine.

const surf = generateSurfaceTextures()
const facades = generateFacadeTextures()
const roofs = generateRoofTextures()
export const decals = makeDecals()
const DETAIL_NORMAL = makeDetailNormal() // shared meso-detail normal for asphalt (Phase 2 #5)

function std(o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial(o)
}

// Hex-tiling (Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 2022 — Phase 2 of
// docs/road-visual-techniques-research.md). Kills the visible ~6 m tile repeat on
// asphalt aggregate by sampling on a triangular/hex lattice: each hex cell fetches
// the source at a per-cell random OFFSET and the three overlapping cells blend by
// barycentric weight. Offset-only (no per-tile rotation) so it drops onto albedo
// without any tangent-frame concern; explicit textureGrad keeps mip selection
// correct across the cell seams (three r169 is WebGL2/GLSL3 — textureGrad is core).
// Applied to ALBEDO only, and only to stochastic asphalt — the research is explicit
// that hex-tiling FAILS on structured textures (cobble/pavers/markings), which is
// why those materials never route through here. Weights are contrast-sharpened to
// counter the mild softening from omitting histogram preservation.
const HEX_TILING_GLSL = `
vec2 cbHexHash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}
vec4 cbHexSample(sampler2D samp, vec2 uv) {
  const mat2 toSkew = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 skew = toSkew * (uv * 3.4641016); // ~3.46 hex cells per texture tile
  vec2 base = floor(skew);
  vec2 f = fract(skew);
  float wz = 1.0 - f.x - f.y;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 v1, v2, v3; vec3 w;
  if (wz > 0.0) { w = vec3(wz, f.y, f.x); v1 = base; v2 = base + vec2(0.0, 1.0); v3 = base + vec2(1.0, 0.0); }
  else { w = vec3(-wz, 1.0 - f.y, 1.0 - f.x); v1 = base + vec2(1.0, 1.0); v2 = base + vec2(1.0, 0.0); v3 = base + vec2(0.0, 1.0); }
  vec4 c1 = textureGrad(samp, uv + cbHexHash(v1), dx, dy);
  vec4 c2 = textureGrad(samp, uv + cbHexHash(v2), dx, dy);
  vec4 c3 = textureGrad(samp, uv + cbHexHash(v3), dx, dy);
  w = pow(w, vec3(3.0));               // sharpen the blend → tighter, less-ghosted seams
  w /= (w.x + w.y + w.z);
  return c1 * w.x + c2 * w.y + c3 * w.z;
}
// Height-blend (Phase 2 #10): crisp, height-aware transition between two layer
// weights (Unreal-style) instead of a soft lerp — used to lay oily/sealed patches
// that follow the aggregate contours rather than a flat sine ramp. d = blend
// contrast. Foundation for the Phase 3 splat/wear-mask asphalt.
float cbHeightBlend(float ha, float hb, float t) {
  float d = 0.25;
  float ma = ha + (1.0 - t);
  float mb = hb + t;
  return clamp((mb - max(ma, mb) + d) / d, 0.0, 1.0);
}
uniform sampler2D cbDetailNormalMap;
uniform float cbDetailRepeat;
uniform float cbDetailStrength;
varying float vCbLane; // -1 (left kerb) .. +1 (right kerb); 0 where no lane frame
varying float vCbWear; // 1 on driven carriageways, 0 elsewhere (gates lane wear)
`

// Large-scale variation keyed to WORLD position (not UV), so long roads don't
// show the 6 m tile repeat and — because it ignores the per-segment UV offset —
// the patchiness stays continuous across segment seams. Cheap multi-sine "noise"
// modulates brightness a little, the same onBeforeCompile pattern the ocean uses.
// Also hex-tiles the albedo fetch (above) to break the tile repeat outright.
function withMacroVariation(m: THREE.MeshStandardMaterial, key: string): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    // detail-normal inputs (Phase 2 #5) — shared texture, ~0.5 m world tile
    shader.uniforms.cbDetailNormalMap = { value: DETAIL_NORMAL }
    shader.uniforms.cbDetailRepeat = { value: ROAD_TILE_M / 0.5 } // vNormalMapUv is per-6m → ×12 = 0.5 m
    shader.uniforms.cbDetailStrength = { value: 0.6 }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCbMacroW;\nattribute float aLane;\nattribute float aWear;\nvarying float vCbLane;\nvarying float vCbWear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCbMacroW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n\tvCbLane = aLane;\n\tvCbWear = aWear;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCbMacroW;\n${HEX_TILING_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          diffuseColor *= cbHexSample( map, vMapUv );
        #endif
        float cbM1 = sin(vCbMacroW.x * 0.071 + vCbMacroW.z * 0.031);
        float cbM2 = sin(vCbMacroW.x * 0.017 - vCbMacroW.z * 0.089);
        float cbMacro = 0.5 + 0.5 * (cbM1 * 0.6 + cbM2 * 0.4);
        diffuseColor.rgb *= mix(0.87, 1.11, cbMacro);
        // #10 height-blend: crisp oily/sealed patches that follow the aggregate
        float cbHeight = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float cbPatch = 0.5 + 0.5 * sin(vCbMacroW.x * 0.043 - vCbMacroW.z * 0.057);
        float cbOily = cbHeightBlend(cbHeight, 0.55, cbPatch);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.74, 0.78), cbOily * 0.45);
        // #7 lane-space wear: polished wheel tracks, oily centreline, dusty kerb
        // edge. Gated by vCbWear so it only paints driven carriageways (0 on
        // junction patches / paths / cobble that carry no lane frame).
        float cbLat = abs(vCbLane);
        float cbAlong = 0.5 + 0.5 * sin(vCbMacroW.x * 0.11 + vCbMacroW.z * 0.09);
        float cbWheel = exp(-pow((cbLat - 0.55) / 0.13, 2.0)) * (0.55 + 0.45 * cbAlong);
        float cbCenterOil = smoothstep(0.13, 0.0, cbLat);
        float cbEdgeDust = smoothstep(0.82, 1.0, cbLat);
        float cbW = vCbWear;
        diffuseColor.rgb *= 1.0 - cbWheel * 0.13 * cbW;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.64, 0.68), cbCenterOil * 0.45 * cbW);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.14, 1.09), cbEdgeDust * 0.30 * cbW);`,
      )
      // #7 roughness: wheel tracks + oil read polished (lower roughness), the dusty
      // kerb edge reads drier (higher). cbWheel/cbCenterOil/cbEdgeDust are declared
      // in the map-fragment block above, still in scope here.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (1.0 - (cbWheel * 0.22 + cbCenterOil * 0.18) * cbW + cbEdgeDust * 0.05 * cbW), 0.0, 1.0);`,
      )
      // #5 detail normal: blend fine grain into the tangent-space normal before the
      // TBN transform, faded out with view distance so far asphalt stays clean.
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          vec3 cbDetN = texture2D( cbDetailNormalMap, vNormalMapUv * cbDetailRepeat ).xyz * 2.0 - 1.0;
          float cbDetFade = 1.0 - smoothstep(18.0, 45.0, length(vViewPosition));
          mapN.xy += cbDetN.xy * cbDetailStrength * cbDetFade;
          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );
        #endif`,
      )
  }
  m.customProgramCacheKey = () => key
  return m
}

// ---------- road surfaces (shared per set; per-segment UV offset via clone) ----------

const ROAD_MATERIALS: Record<RoadSurfaceSet, THREE.MeshStandardMaterial> = {
  'asphalt-new': withMacroVariation(std({ map: surf.asphaltNew.albedo, normalMap: surf.asphaltNew.normal, roughnessMap: surf.asphaltNew.mr, metalnessMap: surf.asphaltNew.mr, roughness: 1, metalness: 1 }), 'cb-asphalt-new'),
  'asphalt-worn': withMacroVariation(std({ map: surf.asphaltWorn.albedo, normalMap: surf.asphaltWorn.normal, roughnessMap: surf.asphaltWorn.mr, metalnessMap: surf.asphaltWorn.mr, roughness: 1, metalness: 1 }), 'cb-asphalt-worn'),
  'asphalt-patched': withMacroVariation(std({ map: surf.asphaltPatched.albedo, normalMap: surf.asphaltPatched.normal, roughnessMap: surf.asphaltPatched.mr, metalnessMap: surf.asphaltPatched.mr, roughness: 1, metalness: 1 }), 'cb-asphalt-patched'),
  cobble: std({ map: surf.cobble.albedo, normalMap: surf.cobble.normal, roughnessMap: surf.cobble.mr, metalnessMap: surf.cobble.mr, roughness: 1, metalness: 1 }),
  pavers: std({ map: surf.pavers.albedo, normalMap: surf.pavers.normal, roughnessMap: surf.pavers.mr, metalnessMap: surf.pavers.mr, roughness: 1, metalness: 1 }),
  gravel: std({ map: surf.gravel.albedo, roughnessMap: surf.gravel.mr, metalnessMap: surf.gravel.mr, roughness: 1, metalness: 1 }),
}

// Arcade road-kit style: clean stylized asphalt (no aggregate, no macro
// variation) for the drivable surfaces; cobble/pavers/gravel are kept from the
// realistic set. A/B against realistic via setRoadStyle + a scene rebuild.
const ARCADE_ASPHALT = std({ map: surf.asphaltArcade.albedo, normalMap: surf.asphaltArcade.normal, roughnessMap: surf.asphaltArcade.mr, metalnessMap: surf.asphaltArcade.mr, roughness: 1, metalness: 1 })
const ROAD_MATERIALS_ARCADE: Record<RoadSurfaceSet, THREE.MeshStandardMaterial> = {
  'asphalt-new': ARCADE_ASPHALT,
  'asphalt-worn': ARCADE_ASPHALT,
  'asphalt-patched': ARCADE_ASPHALT,
  cobble: ROAD_MATERIALS.cobble,
  pavers: ROAD_MATERIALS.pavers,
  gravel: ROAD_MATERIALS.gravel,
}

// tile every attached map (albedo AND normal) to the same 6 m world period so
// the normal never tiles at a different rate than the albedo it rides on
for (const m of [...Object.values(ROAD_MATERIALS), ARCADE_ASPHALT]) {
  for (const t of [m.map, m.normalMap]) t?.repeat.set(1 / ROAD_TILE_M, 1 / ROAD_TILE_M)
}

export type RoadStyle = 'realistic' | 'arcade'
let activeRoadStyle: RoadStyle = 'realistic'
/** Switch the road surface material set. Followed by a scene rebuild so every
 *  road mesh re-reads roadMaterial() (materials are cloned per segment at build). */
export function setRoadStyle(style: RoadStyle): void {
  activeRoadStyle = style
}

export function roadMaterial(set: RoadSurfaceSet, uvSeed = 0): THREE.MeshStandardMaterial {
  const base = (activeRoadStyle === 'arcade' ? ROAD_MATERIALS_ARCADE : ROAD_MATERIALS)[set]
  if (uvSeed === 0) return base
  // seeded per-instance UV shift breaks visible tiling between adjacent segments;
  // albedo + normal share the same offset so their aggregate stays registered
  const m = base.clone()
  const ox = uvSeed % 1
  const oy = (uvSeed * 7.13) % 1
  m.map = base.map!.clone()
  m.map.offset.set(ox, oy)
  if (base.normalMap) {
    m.normalMap = base.normalMap.clone()
    m.normalMap.offset.set(ox, oy)
  }
  return m
}

export const sidewalkMaterial = std({
  map: surf.sidewalk.albedo,
  normalMap: surf.sidewalk.normal,
  roughnessMap: surf.sidewalk.mr,
  metalnessMap: surf.sidewalk.mr,
  roughness: 1,
  metalness: 1,
})
for (const t of [sidewalkMaterial.map!, sidewalkMaterial.normalMap!]) t.repeat.set(1 / 2.4, 1 / 2.4)

// ---------- building facades (per-instance tint + seeded UV offset) ----------

const FACADE_GLASSINESS: Record<FacadeSet, { rough: number; metal: number }> = {
  'brick-red': { rough: 0.92, metal: 0 },
  'brick-brown': { rough: 0.92, metal: 0 },
  'stucco-warm': { rough: 0.95, metal: 0 },
  'stucco-cool': { rough: 0.95, metal: 0 },
  'concrete-panel': { rough: 0.85, metal: 0 },
  'office-glass': { rough: 0.35, metal: 0.25 },
  'curtainwall-dark': { rough: 0.28, metal: 0.35 },
  'storefront-mixed': { rough: 0.7, metal: 0.05 },
}

export function facadeMaterial(set: FacadeSet, tint: string, uvSeed: [number, number]): THREE.MeshStandardMaterial {
  const g = FACADE_GLASSINESS[set]
  const map = facades[set].clone()
  map.repeat.set(1 / FACADE_TILE_M.w, 1 / FACADE_TILE_M.h)
  map.offset.set(uvSeed[0], uvSeed[1])
  map.needsUpdate = true
  return std({ map, color: tint, roughness: g.rough, metalness: g.metal })
}

const ROOF_MATERIALS: Record<RoofSet, THREE.MeshStandardMaterial> = {
  'bitumen-dark': std({ map: roofs['bitumen-dark'], roughness: 0.95 }),
  'tile-red': std({ map: roofs['tile-red'], roughness: 0.85 }),
  'metal-pale': std({ map: roofs['metal-pale'], roughness: 0.5, metalness: 0.6 }),
  'concrete-pale': std({ map: roofs['concrete-pale'], roughness: 0.92 }),
}
for (const m of Object.values(ROOF_MATERIALS)) m.map!.repeat.set(1 / 4, 1 / 4)

export function roofMaterial(set: RoofSet): THREE.MeshStandardMaterial {
  return ROOF_MATERIALS[set]
}

// ---------- decal materials (content, not post-FX) ----------

// No polygonOffset: decals sit a real 30mm above the road layer, which the
// log-depth buffer resolves at any in-scene distance (see editor/depthConfig.ts).
// polygonOffset is also silently ignored once log depth writes gl_FragDepth.
function decalMat(tex: THREE.Texture): THREE.MeshStandardMaterial {
  return std({ map: tex, transparent: true, roughness: 1, depthWrite: false })
}

export const decalMaterials = {
  crack: decalMat(decals.crack),
  stain: decalMat(decals.stain),
  patch: decalMat(decals.patch),
  manhole: decalMat(decals.manhole),
}
