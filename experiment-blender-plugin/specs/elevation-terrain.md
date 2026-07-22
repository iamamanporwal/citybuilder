# CityBuilder Elevation/Terrain Spec (extracted from app source, for Python port)

All coordinates are 2D world (x, z) in metres; "elevation" is the y-channel in true metres (0 = grade). Everything is deterministic: no RNG, no wall-clock, key-sorted traversal, fixed iteration budgets. The determinism hash is FNV-1a → `hash01` (see §C).

NOTE FOR THE BLENDER PORT: the app is Y-up with (x, z) ground plane; the Blender addon is
Z-up with (x, y) ground plane. Substitute z→y in ground coords and y→z for elevation.

## A. Road corridor elevation solve

### Inputs / outputs
- Input: `roads: RoadSegment[]`. Each segment has `id`, `points: Vec2[]` (polyline), `roadClass`, `widthM`, `bridge: bool`, `tunnel: bool`, `layer: int`.
- Output object `NetworkElevation`:
  - `nodeElevation(key) -> float` (0 if unknown)
  - `edgeGrades(edgeId) -> {start, end} | null` (dz/ds at each end, measured start→end)
  - `profileFor(r, cum) -> float[]` — per-station true elevation for a road, `cum` = cumulative arc-length array along that road's polyline
  - `clusterOf(key) -> canonicalKey | null`
  - `isInternal(roadId) -> bool`

### Node key (half-metre snap)
```
nodeKey(p) = f"{round(p.x*2)},{round(p.z*2)}"
```

### Scope: which roads become graph edges
Edge iff `roadClass ∉ NON_DRIVABLE` AND `not tunnel` AND `len(points) >= 2`.
`NON_DRIVABLE = {pedestrian, footway, cycleway}`.
Paths / tunnels / degenerate fall through to the legacy per-segment ramp math (§A6).

### Grade caps by class (fraction rise/run)
```
motorway 0.04, trunk 0.04, primary 0.06, secondary 0.06, tertiary 0.07,
residential 0.08, unclassified 0.08, living_street 0.08, service 0.08,
pedestrian 0.12, footway 0.12, cycleway 0.10;  default (unknown) 0.08
```

### Solver tuning
```
maxIterations = 80
tolerance     = 1e-4   # convergence on max per-iteration node move (m)
baseWeight    = 0.25   # pull toward terrain base height
BRIDGE_LAYER_H = 6.5   # deck height per layer (m)
MAX_RAMP_GRADE = 0.06
```

### Overall procedure — two-pass so junction consolidation judges at solved heights
1. `graph1 = buildRoadGraph(roads)` (no alias).
2. `pass1 = solveNodeElevations(graph1)`.
3. `consolidation = clusterJunctions(graph1, pass1.z)` (§B).
4. If any aliases: `graph = buildRoadGraph(roads, consolidation.alias)`; else reuse `graph1`.
5. `z = solveNodeElevations(graph)` (final node heights).
6. `grades = solveEdgeGrades(graph, z)`.
7. `zAt(key) = z[alias.get(key) or key] or 0`.

### Graph build
- `keyOf(p) = alias.get(nodeKey(p)) or nodeKey(p)`.
- For each in-scope road: `startKey=keyOf(points[0])`, `endKey=keyOf(points[-1])`.
  - If `startKey==endKey`: if alias present and raw keys differ → record as **internal edge** (junction-interior link, no elevation constraint); else degenerate self-loop → skip.
  - `length = polyline length of r.points`; skip if `< 1e-3`.
  - `bridgeElev = max(layer,1)*6.5 if bridge else 0`.
  - Store edge {id, seg, startKey, endKey, length, maxGrade=maxGradeFor(class), bridge, layer}.
  - Add incident records to both end nodes: {edgeId, end, farKey, length}.
  - For each end node: `hasSurface |= not bridge`; `bridgeElev = max(bridgeElev, edgeBridgeElev)`.
- Classify each node by degree: `>=3` → junction, `==2` → joint, else endpoint.
- **Pin**: `pin = bridgeElev if (bridgeElev>0 and not hasSurface) else null`. (A node touched only by bridge edges is pinned to deck height; a node with any at-grade edge is free.)

### A1. Node relaxation (projected Gauss-Seidel)
- `baseHeight(p) = sampleTerrainBase(p.x, p.z)` (NATURAL terrain, §C; 0 when terrain off).
- Init: `z[key] = pin if pin is not None else baseHeight(node.p)`.
- Visit keys in **sorted order** each iteration.
- For up to `maxIterations`:
  - For each node with `pin is None`:
    - `num = baseWeight * baseHeight(p)`, `den = baseWeight`.
    - `lo = -inf`, `hi = +inf`.
    - For each incident edge: `zj = z[farKey]`, `w = 1/length`; `num += w*zj`, `den += w`; `span = edge.maxGrade * length`; `lo = max(lo, zj-span)`, `hi = min(hi, zj+span)`.
    - `target = num/den`.
    - `next = clamp(target, lo, hi)` if `lo <= hi` else `(lo+hi)/2`.
    - Track `|next - prev|` into `maxMove`; set `z[key]=next`.
  - Break if `maxMove < tolerance`.

### A2. Edge grades
Per-node outward grade into each incident edge, then combined into per-edge {start,end}.
- Iterate sorted node keys. For a **joint** (degree exactly 2), shared through-tangent (C¹):
  - incidents `[A,B]`; `m = (z[B.farKey] - z[A.farKey]) / (A.length + B.length)`.
  - `outGrade[key][A.edgeId] = clamp(-m, -capA, capA)`; `outGrade[key][B.edgeId] = clamp(m, -capB, capB)`.
- Otherwise each edge uses its own secant: `outGrade[key][edgeId] = clamp((z[farKey]-z[key])/length, -cap, cap)`.
- Per edge: `grades[id].start = outGrade[startKey][id] or 0`; `grades[id].end = -(outGrade[endKey][id] or 0)`.

### A3. Per-edge profile — `profileFor(r, cum)` (cum = cumulative arc lengths, last = L)
1. **Internal edge**: flat at cluster height → `[zAt(nodeKey(r.points[0]))] * len(cum)`.
2. **Not a corridor edge** (path/tunnel/degenerate): legacy fallback (§A6).
3. **Corridor bridge edge**: eased hump/deck:
   - `fullElev = max(layer,1)*6.5`.
   - `rampLen = min( max(fullElev/edge.maxGrade, 40), max(L*0.45, 20) )`.
   - Per station d: `up = z0 + (fullElev - z0)*ease(d/rampLen)`; `down = z1 + (fullElev - z1)*ease((L-d)/rampLen)`; profile = `min(up, down)`.
   - **ease is COSINE**: `ease(t) = 0.5 - 0.5*cos(π*clamp(t,0,1))`.
4. **Corridor non-bridge edge**: C¹ cubic Hermite:
   - `m0 = grades[id].start * L`, `m1 = grades[id].end * L`.
   - `profile(d) = hermite(d/L, z0, z1, m0, m1)`;
     `hermite(t,z0,z1,m0,m1) = (2t³-3t²+1)z0 + (t³-2t²+t)m0 + (-2t³+3t²)z1 + (t³-t²)m1`.

### A5. Densify
- Smooth polyline: Catmull-Rom 'centripetal', spacing 4 m, only if length >= 14 m (optional nicety).
- Bridges: densify to max 8 m spacing so 2-point OSM bridges sample their hump. Constant = 8 m.

### A6. Legacy per-segment ramp fallback (paths/tunnels)
- `shortSpanElevCap(L, grade) = grade*L/π`.
- Path bridge: `fullElev = min( max(layer,1)*6.5, shortSpanElevCap(L, maxGradeFor(class)) )`; `rampLen` as §A3; `startElev/endElev = 0 if end node grounded else fullElev` (grounded = endpoint of any at-grade non-bridge non-tunnel way).
- `up = startElev + (fullElev-startElev)*ease(d/rampLen)`; `down = endElev + (fullElev-endElev)*ease((L-d)/rampLen)`; `min(up,down)`; cosine ease.

## B. Junction consolidation (§15)

Cluster junction nodes → contract each cluster to one super-node → re-solve so a whole
bridgehead sits at ONE height.

### Constants
```
INTERNAL_EDGE_FACTOR = 1.5
PROXIMITY_FACTOR     = 1.0
Z_GATE_EDGE          = 2.0   # m — max |Δz| to contract an internal edge
Z_GATE_PROXIMITY     = 1.2   # m — max |Δz| to merge overlapping discs
MAX_SPAN_M           = 45    # max cluster bbox diagonal (incl. disc radii)
CELL                 = 18    # spatial-hash cell (m)
discRadius(maxWidth) = maxWidth * 0.58   # per node, from widest incident edge
```

### Algorithm
1. Per node: `radius = discRadius(max incident widthM)`.
2. Union-find with per-root AABB. Init box = position dilated by radius.
3. **Rule 1 — internal-edge contraction**: edge where `degree(start)>=2 and degree(end)>=2`, `edge.length <= 1.5*(radStart+radEnd)`, `|Δz| <= 2.0`. Candidate {d: length, a, b}, a<b lexicographic.
4. **Rule 2 — proximity**: hash junction-degree nodes into 18 m cells; pair if `dist <= 1.0*(radA+radB)` and `|Δz| <= 1.2`.
5. Sort candidates by (d asc, a, b). For each, tryUnion: reject if merged bbox diagonal > 45 m; canonical root = lexicographically smaller key.
6. Clusters with >= 2 members → alias map member→canonical.
7. Rebuild graph with alias. Edges whose ends collapse to the same canonical (raw keys differ) = **internal edges**: flat at cluster height, no ribbon (the junction pad is their surface).

Renderer notes: merged junction patch = polygon union of member discs at the single node
height; degree-2 pass-through joints (dot <= -0.866, width ratio <= 1.35) get no
disc/trim/crosswalk; bridge fascia only where deck > 0.8 m above grade; piers where > 3.5 m.

## C. Terrain field

### Constants (metres)
```
cell            = 12     # bake-grid resolution
reliefAmp       = 2.6    # peak macro relief away from water (±)
reliefWavelength= 230    # base wavelength of octave 0
reliefOctaves   = 3      # each ½ amplitude, 2× frequency
waterSurfaceY   = -1.2   # water plane height
riverbedY       = -3.0   # ground under water
shoreY          = -0.85  # bank lip at water's edge
valleyWidth     = 150    # bank rises from shore to base grade over this distance
waterFlatten    = 45     # within this of water, macro relief flattened
```

### Value noise
- `latticeValue(ix,iz,octave) = hash01(f"{ix}:{iz}:{octave}")` where `hash01(s)` = FNV-1a:
  `h=2166136261; for ch: h^=ord(ch); h=(h*16777619) mod 2^32; return h/4294967296`.
- `smoothstep(t) = c*c*(3-2c)`, c=clamp(t,0,1) — CUBIC (terrain only; roads use cosine ease).
- `valueNoise(x,z,wavelength,octave)`: bilinear-smoothstep blend of 4 lattice corners, mapped to [-1,1].
- `fbm(x,z)`: octaves o=0..2: `sum += amp*valueNoise(...)`; `norm += amp`; `amp *= 0.5`; `wavelength *= 0.5`; start amp=1, wavelength=230. Return sum/norm.

### Height composition — heightAt(x,z)
`reach = valleyWidth + 4`.
```
if insideWater(x,z):  return riverbedY                       # -3.0
valley = 0; farFromWater = True
if within water-bbox±reach:
    d = distToWater(x,z)          # min point-to-segment dist to ring/hole edges
    farFromWater = (d >= valleyWidth)
    valley = shoreY + (0 - shoreY) * smoothstep(d / valleyWidth)
    mask   = smoothstep((d - waterFlatten) / valleyWidth)
    return valley + fbm(x,z) * reliefAmp * mask
return (0 if farFromWater else valley) + fbm(x,z) * reliefAmp
```
insideWater = in ring and not in its holes. DEM mode replaces fbm with real data but KEEPS
the riverbed/shore compositing near water.

### Bake + sample
Grid over bounds at cell=12; bilinear sample; clamped edges. Terrain off → sample()=0.

### Road conform — conformTerrainToRoads (one-way: roads → ground)
The road solve samples the NATURAL field; the ground mesh samples the CONFORMED field.
- `SHOULDER = 14` m; corridor = {pts (densified centerline), elev (profileFor), half = width/2, pave = 4}.
- Corridors from every drivable, non-tunnel, non-bridge, non-internal road.
- Bucket corridor segments into 24 m grid cells over reach = half+pave+SHOULDER.
- sample(x,z): hb = base. Over 3×3 cells, per segment: d, t = closest; flat = half+pave;
  w = 1 if d<=flat; else cubic smoothstep((flat+SHOULDER-d)/SHOULDER) if d<flat+SHOULDER; keep LARGEST w;
  bestE = lerp(e0,e1,t). Return bestE*w + hb*(1-w).

### Ground mesh
Grid cell = max(6, ceil(max(w,d)/380)) (~6 m); vertices at conformed sample.

## D. Building seating + over-water piers

- `BASE_SINK = 0.4` m — building base sits 0.4 m below sampled ground at footprint centroid; top at `ground + heightM`.
- Cornice (flat roofs): scale min(1.06, max(1.01, 1+0.4/r)), band 0.7 m, overhang 0.4, skip if half-extent < 3.
- Over-water: if >= 50% of footprint VERTICES over rendered water → reseat to grade 0 and add pier: flat cap ring at 0 + skirt wall dropping `PIER_DROP = 3.0` m. One merged mesh for all piers.
- No terrain flattening near buildings (only roads conform ground).

## E. Ease-function gotcha
- Road elevation solve + ramps: **cosine ease** `0.5 - 0.5*cos(π t)`.
- Terrain field + road-conform blend: **cubic smoothstep** `t²(3-2t)`.
Port them separately.
