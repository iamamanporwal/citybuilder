# Framed Roads — Cross-Section System Spec (extracted from app source, for Python port)

PORT DECISION: port **System 1 (in-app procedural builder, the a2 contract)** as authoritative,
with the kit's junction corner-arc idea (System 2) where it simplifies. App is Y-up (x,z ground);
Blender port is Z-up (x,y ground) — swap accordingly.

## 1. Cross-section profile (System 1, per side, from carriageway edge outward)

```
asphalt edge | 0.05 reveal | CURB strip (curbW) | tree-lawn VERGE (vergeW) | FOOTPATH (footW) | outer skirt down to grade
```

Heights relative to the road surface at that station:
- FRAME_CURB_H = 0.16  — curb top AND footpath top (flush at +0.16)
- FRAME_VERGE_H = 0.04 — tree-lawn trough at +0.04 (LOWER than curb and footpath)
- SIDEWALK_FOUNDATION = 0.35 — vertical faces run DOWN to base − 0.35 (never floats)
- Curb inner face starts at half + 0.05 (5 cm reveal)

Vertical layer stack (paint sits mm above road):
```
terrain 0 < water .012 < grass .022 < park .032 < sand .037 < forest .042
< Y_PATH .046 < Y_ROAD .05 < Y_MARK .055 < Y_DECAL .06 < Y_DISC .065 < Y_CROSSWALK .07
```
PLAZA_CURB_H = 0.14. LANE = 3.4 m.

## 2. Per-class presets — framedPresetFor(roadClass) → {curbW, vergeW(tree-lawn), footW}

| class | curbW | tree-lawn | footW | framed? |
|---|---|---|---|---|
| motorway, trunk | — | — | — | frameless (shoulders only) |
| primary | 0.45 | 1.0 | 2.4 | yes |
| secondary | 0.42 | 1.2 | 2.2 | yes |
| tertiary, unclassified | 0.40 | 1.3 | 2.0 | yes |
| residential, living_street | 0.40 | 1.6 | 1.8 | yes |
| default | 0.40 | 1.3 | 2.0 | yes |

Frame only if drivable && !bridge && preset. Bridges get no sidewalk frame.
service → verge 0, footpath 0 (curb only). Cobble streets: cobble carriageway, verge 0,
footpath 1.5, no markings. Tree-lawn tapers to 0 within ~4 m of a junction.

## 3. Curb geometry & normals

- Vertical curb face, NOT beveled: wall from road surface up to +0.16; inner face extends
  down to −0.35 foundation.
- One vertical skirt per height step (adjacent bands share exact seams — exactly one wall
  per step, no coplanar walls).
- All flat tops re-wound so normals point UP (+Z in Blender); overlapping tops use
  world-planar UVs (uv = (x, −y) in Blender terms) so overlaps sample identical texels.

## 4. Lane markings (flat geometry strips, NOT decals/shaders)

Materials: markingWhite #f2f1ea rough 0.75; markingYellow #e6c23e rough 0.75.
Painted at Y_MARK = 0.055 above road surface; crosswalks/stop lines at 0.07.

Center pattern by region (default EU-ish white-dashed; US double-yellow):
- double-solid: two ribbons at lateral ±0.18, each 0.12 m wide
- solid: one ribbon 0.16 m wide
- dashed centre: dash 3 m, step 9 m (gap 6 m), 0.16 m wide; first dash at 2 m along
- one-way >=2 lanes: dashed lane lines at −half + (width/lanes)·k for k=1..min(lanes,4)−1

Crosswalks — only at real junctions, class != motorway && width >= 5:
- stripe count = max(3, floor((width−2)/1.6)), lateral spacing 1.6 m, centred,
  placed 1.6 m inward from trimmed end
- stripe quad: 2.2 m along travel × 0.8 m wide (zebra)

Stop lines — {trunk, primary, secondary, tertiary}:
- 3.15 m inward; bar 0.6 m thick; halfWid = width/2−0.2 (one-way) or width/4−0.1
  (two-way, driving-side half, offset ±width/4)

## 5. Junction handling (the "Lego rule")

- Every road at a node trims to the same radius: discRadius = maxIncidentWidth * 0.58;
  junctionRadius = maxWidth * 0.55; ribbons trim to junctionRadius * 0.72 at degree>=3.
- Pad shape: boolean union of each arm's rectangle (anchored at node, run to trimmed ribbon,
  flared by JUNCTION_FLARE = 1.3), then corners rounded with fillet
  clamp(maxWidth*0.45, 2, 7). Fallback: convex hull of carriageway mouth corners
  (Andrew's monotone chain — the kit approach, simpler, port this).
- Corner frame wrap: classify pad-ring vertices as mouth (over a road exit: lateral <
  half*1.35 + 0.8 from an arm ray) vs corner; contiguous non-mouth runs offset outward by
  curbW then curbW+footW (junction fixed curbW=0.4, footW=2.4); emit curb wall, curb top,
  footpath top, outer skirt to −0.35. Skip any run whose band point lands on asphalt.
- Kit alternative for corners: per corner between adjacent arms, fill curb → lawn → footpath
  bands between two arcs swept around the node (6 segments); if arms > 2.7 rad apart,
  arcs collapse to straight lines. junctionPadRadius = carriageHalf + curbW + lawnW + footW
  + vergeW + flare (flare 0.6).
- Roundabout: island R6, ring +7, kerb 0.4, foot 2.0, grass 1.6. Cul-de-sac: bulb R9.

## 6. Crown / superelevation (crossSection.ts)

- CROWN_SLOPE = 0.02: centre raised 0.02·halfWidth·(1−ln²) above edges; 0 at kerbs
  (ln ∈ [−1,+1], 0=centre). Curb seam untouched.
- SUPERELEV_MAX = 0.06 (6% bank) at curvature 0.02/m (~50 m radius); offset = bank·halfWidth·ln;
  sign = −sign(curvature) (outer edge up); endpoints 0.5× neighbour.
- crossFade: crown/bank ramps to 0 within TAPER_M = 6 m of each segment end.
- 5 lateral samples per station (edges + centre + quarters); carriageway only.

## 7. Elevation interplay

Frame is surface-relative: base = road surface elevation per station (from network solve);
curbTop = base+0.16, vergeTop = base+0.04, skirt bottom = base−0.35. Crown is 0 at kerbs so
frame follows only the centreline profile. Junction pads flat at the node height.

## 8. Geometry primitives to port

- offsetPolyline: miter left-normal, miter scale min(1/max(cosHalf,0.45), 2.2), fold-over collapse.
- offsetPolylineVar: per-point offsets (for gap-clamped bands).
- ribbonGeometry(left,right): strip; UV = (across, along-metres).
- wallGeometry(pts, z0, z1); raisedRibbonGeometry(left,right,h,base) = top + two skirts.
- trimPolyline(pts, trimStart, trimEnd); pointAlong; roundPolygon(ring, radius, segs=4);
  convexHull (Andrew's monotone chain); arcBetween(center, p0, p1, segs=6).
