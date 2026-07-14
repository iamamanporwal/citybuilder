📄 Required file type for your map-creation workflow
Everything must be GLB (glTF binary). The engine's world "conform spec" ideally wants a 4-GLB set, but yours maps fine to 2:

Engine slot	Purpose	Your file
surface (required)	drivable/raycast ground + minimap source	city_scene.glb
collider (required)	Rapier physics trimesh	city_collision.glb
environment (optional)	visual scenery	(reused city_scene.glb)
minimap (optional)	dedicated top-down map	missing → falls back to surface
So: GLB is the required type, and the minimum is scene.glb + collision.glb. Your city_semantics.json / textures_manifest.json aren't consumed by the runtime today (they're metadata) — but they're gold for automation (see below). One thing to note: your scene uses KHR_materials_unlit, so the city renders fullbright and won't react to the game's day/night lighting — fine for testing, worth deciding on later.

3 ways to make the map pipeline better
Compress at export (biggest win). Your files are 55 MB uncompressed (31 MB scene + 24 MB collider), which is what makes the dev server choke here. Add a Draco (geometry) + KTX2/Basis (textures) bake step to the pipeline — the engine already decodes both. Your textures_manifest.json even specifies KTX2 codecs per texture, so you're one bake step away. Expect ~4–8× smaller and far faster loads on mobile/iPhone (the documented VRAM crash lever).

Emit the collider pre-merged + reduce materials. Ship one merged collision mesh (I merge at load now, but doing it at export saves the runtime cost and matches the "1 collider = no freeze" rule). And the scene has 2,217 materials → that's a draw-call problem (exactly what your lead flagged on other maps). Merge road/building materials into shared atlases at export.

Auto-generate the spawn + minimap from city_semantics.json. You already export road centerlines, drivable, width, and lanes. The pipeline could emit a tiny citymap_spawn.json (a good drivable start point + heading) and a dedicated citymap_minimap.glb (roads only) — so a new map needs zero code edits, just files. Right now I had to hand-pick the spawn from the semantics.

⚠ One environment issue to flag
Your Node is v20.20.2 but the project requires ≥22.12 (Vite 8). The npm run dev:full server silently crashes when serving these large GLBs — that's why I built + served a static preview instead. Upgrade Node to 22+ and the normal dev workflow will be stable. (I also ran npm install — leaflet and typescript were declared but missing from node_modules.)

Nothing is committed — the changes are in your working tree (git status shows the 4 edited files + 2 new GLBs). Want me to add a world-picker tile for it (so it's clickable instead of URL-only), or wire the semantics-driven spawn/minimap auto-generation?