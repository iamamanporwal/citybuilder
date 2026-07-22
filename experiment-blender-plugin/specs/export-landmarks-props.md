# Export Contract + Landmarks + Props Spec (extracted from app source, for Python port)

App is Y-up (x,z ground); Blender port is Z-up (x,y ground). glTF export from Blender is
Y-up automatically. Unity export negates X; headings negated with it.

# A. GAME EXPORT CONTRACT

Artifacts (one GLB per semantic role — NOT spatially tiled):
| file | root object name | contents |
|---|---|---|
| city_scene.glb | citybuilder_scene | visual city, merged; children `${type}__${id}` |
| city_collision.glb | citybuilder_colliders | merged colliders, userData.formatVersion=2 |
| city_surface.glb | citybuilder_surface | drivable-only subset (wheel raycasts) |
| citymap_minimap.glb | citybuilder_minimap | flat y=0 road ribbons per class color, `mm_<hex>` |
| city_semantics.json | — | semanticsVersion 3 |
| citymap_spawn.json | — | spawnVersion 1 |

Units: glTF right-handed, Y-up, metres, origin = area center, y0 = grade.

## unity_city.json (formatVersion 1) — exact schema
```
format: "citybuilder-unity-city"
formatVersion: 1
city: str
attribution: "© OpenStreetMap contributors (ODbL 1.0)"   // must show in-game
bounds: {minX, maxX, minZ, maxZ}
coordinateSystem: {up:"Y", units:"meters", handedness:"left (Unity, X negated...)", origin:"area center"}
spawn: {position:[x,y,z], heading_rad} | null
stats: {roads, drivable_roads, road_km_by_class, total_road_km, buildings, traffic_devices}
roads: [{id:"road_<osmid>", name, class, drivable, width_m, lanes, lane_width_m,
         oneway, speed_limit_kmh, speed_limit_source:"tag"|"default"|null, turn_lanes,
         roundabout, bridge, tunnel, surface, length_m, centerline:[[x,y,z],...]}]  // y solved
traffic_devices: [{id, kind, position:[x,y,z], heading_rad, sign_type?, speed_limit_kmh?}]
  // kinds: traffic_signal, speed_limit, give_way, stop_sign, road_sign
buildings: [{id:"bld_<osmid>", name?, tier, position:[x,y,z], look:{facade,roof,tint}|null}]
```
Rounding: positions 2 dp, headings 4 dp.

## Spawn selection
score = centre*0.4 + class*0.25 + width*0.2 + length*0.15; drivable, non-bridge, non-tunnel,
length >= 20 m; classRank primary 5 / secondary 4 / tertiary 3 / residential 2 / service 1;
widthScore = min(1, w/12); lengthScore = min(1, len/120).
heading_rad = atan2(-dz, dx) (yaw about +Y, 0=+X, CCW).
Default speeds km/h: motorway 100, trunk 90, primary 60, secondary/tertiary 50,
unclassified 40, residential 30, living_street/service 20, pedestrian 10.

Contract string: `w1.s3.c2.a2` (manifest v1, semantics 3, collider 2, asset rev a2 = framed roads ON).

# B. LANDMARK SYSTEM

Catalog entry: {id, label, wikidata QIDs, namePattern regex, category, color}.
Categories: suspension-bridge | cable-stayed-bridge | stone-arch-bridge.
Match order: wikidata QID → name pattern → bridge:structure tag fallback
('suspension' → generic #9a9ea3, 'arch' → sandstone #b8a883).
Seeds: Charles Bridge (Q204871, stone-arch #b8a883, towers), Golden Gate (Q44440,
suspension, International Orange #c0362c), Brooklyn (Q123067 #9a8c78), Tower Bridge (Q83125).
Contiguous bridge segments chained (join tolerance 45 m); width = max segment width.
Deck height = 6.5*layer + 0.05.

## Suspension bridge — buildSuspensionBridge(centerline, widthM, {color, deckY})
- Reject if L < 45 m. half = max(width/2, 4). towerH = clamp(L*0.16, 24, 130).
- Towers at 30% and 70% of span; legs box legW = max(2, half*0.16) × towerH at both deck
  edges, tower tops at deckY+towerH. Cross-braces at 0.62 and 0.92 of towerH.
- Main cable per side, parabolic: sag = towerH*0.86;
  y = deckY + towerH − sag·(1 − (2t−1)²) between towers; anchorages at 2 m from ends at deckY+1.
  Tube radius max(0.35, half*0.045).
- Suspenders every 16 m between towers: vertical cylinders r=0.18 from deckY+1.2 to cable.
- Girder/railing walls both edges deckY−1.6 → deckY+1.2.
- Materials: struct rough 0.6 metal 0.2; cable rough 0.45 metal 0.35; both spec.color.

## Stone arch — buildArchBridge(centerline, widthM, {color, deckY, waterY=0, towers})
- Reject if L < 40 m. half = max(width/2, 2.5). parapetH=1.05, deckThk=0.7, crown=deckY−0.7.
- nSpans = clamp(round(L/28), 3, 20); spanPitch = L/nSpans;
  pierHalf = clamp(spanPitch*0.13, 1.4, 3.2); openHalf = max(spanPitch/2 − pierHalf, 2);
  rise = clamp(openHalf*0.72, 1.5, crown−waterY−1.6); springY = crown − rise;
  archRad = (openHalf² + rise²)/(2·rise); circleCY = crown − archRad.
- Underside: within pierHalf of pier station → waterY; inside openHalf → circular arc
  circleCY + sqrt(archRad²−local²); else springY. Stations: 1.5 m grid + pier-edge pairs.
- Spandrel walls both edges (arch profile → deckY+parapetH), deck at deckY, piers box
  (2half+0.4) × (springY−waterY) × (2 pierHalf) + triangular cutwaters (len pierHalf*1.6).
- Towers (Charles): gateH 5.5, bodyH 13, coneH 7 at 5%/95% of L.
- Stone rough 0.92.

# C. PROPS

## OSM node → prop kinds
traffic_signals→traffic_signal, stop→stop_sign, give_way→give_way, crossing→semantics only,
natural=tree→tree, street_lamp→lamp (position authoritative), bench, waste_basket→bin,
fountain, bus_stop, memorial/monument/artwork→statue, traffic_sign=*→road_sign.

## Curbside device placement
- If dist to nearest drivable road > half + 0.2 → keep raw position.
- Else push perpendicular to driving side (right-hand: s=−1): offset = half + 0.7 m.
- Orientation: traffic_signal aligns WITH travel; stop/give_way/road_sign rotate 180° to
  CONFRONT driver.
- Elevation: dist <= half+8 → solved road elevation, else terrain.

## Generated furniture (roads {primary..living_street, trunk}, skip tunnels, L>=20)
- Lamps: spacing by zone (commercial 26, retail 24, residential 34, industrial 48, park 40,
  default 36); lateral = half + 1.1 (bridge: half − 0.55, hug parapet, only width>=8);
  alternating sides; jitter ±3 m along (0 on bridge); reject inside carriageway (margin
  0.35), on water, or within 8 m of another lamp. Lamp pole 7.4 m, arm 2.2 m @ 7.3.
- Signs at segment ends: ~35% chance/end, 6 m in, offset half+0.8, face oncoming.
- Speed signs only when OSM maxspeed tagged: station min(15, L*0.25), offset half+1.2.
- Benches/bins by zone density — skip for Blender v1 (park benches only maybe).
- No benches/bins/signs on bridge decks; lamps allowed.
- Elevation: lamps/furniture y = road elevation at station + 0.22 curb (drivable non-service
  non-bridge); signs/devices = road elevation; trees/vegetation = terrain only.

## Vegetation verge (drivable, non-bridge, non-tunnel, L>=12)
- Both sides, along from spacing*0.5 step spacing (residential 1.6, park 1.1, default 1.4).
- Lateral = half + 1.4 + hash·band (band residential 3.6, park 5.0, default 4.5).
- Grass scale 0.72+hash·0.6; shrub every ~6-7 tufts, extra offset 0.8+hash·1.2, scale 0.55+0.6.
- Global budget: grass 26000, shrub 6000.

## Prop dims
traffic signal: pole r0.09→0.11 h4.6, head box 0.34×1.0×0.26 @ 4.4, 3 lamps r0.09 @ 4.4±0.3.
bench seat 1.7×0.5 @ 0.45; bin cyl r0.28 h0.85; sign pole 2.6 m + plate (circle r0.38 or
0.6×0.75 rect); STOP = red octagon.
