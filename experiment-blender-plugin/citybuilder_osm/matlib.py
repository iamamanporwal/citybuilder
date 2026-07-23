"""Procedural material library (bpy) — SPEC.md §matlib.

MATERIALS maps every key of SPEC.md's fixed material vocabulary (plus
lamp_head, sign_red, sign_white, landmark_steel) to (display_name, builder).
get(key) returns a cached bpy material named "CB <key>", rebuilding the node
graph if the cached datablock lost it. get(key, color="#rrggbb") returns a
tinted variant cached as "CB <key> <hex>" (landmarks: painted steel).

All looks are procedural Principled-BSDF node graphs (no image textures) so
generated .blends stay self-contained. The facade window grid and lit-window
emission are driven by UV-in-metres (u = metres along wall, v = metres up)
plus the per-face float attribute "tint" — roofs.py guarantees both. Every
material also sets mat.diffuse_color (and viewport roughness/metallic) so
Solid/Workbench shading reads sensibly.

Self-test (needs Blender's bpy):
    blender --background --factory-startup --python citybuilder_osm/matlib.py
"""
import math

import bpy


# ---- colour helpers -----------------------------------------------------------

def _hex_rgba(h, mul=1.0):
    """'#rrggbb' → linear-space RGBA tuple; mul scales lightness (for ±variation)."""
    h = h.lstrip("#")
    def lin(u):
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (min(1.0, lin(r) * mul), min(1.0, lin(g) * mul), min(1.0, lin(b) * mul), 1.0)


def _norm_hex(color):
    """Normalise '#C03', 'c0362c', '#C0362C' → '#c0362c' (cache-name stable)."""
    c = str(color).lstrip("#").lower()
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return "#" + c


# ---- node helpers -------------------------------------------------------------

def _set(node, names, value):
    """Set the first existing input socket among candidate names (API drift-proof)."""
    if isinstance(names, str):
        names = (names,)
    for n in names:
        s = node.inputs.get(n)
        if s is not None:
            s.default_value = value
            return s
    return None


def _in(node, ident):
    """Input socket by identifier (ShaderNodeMix has same-named sockets per type)."""
    for s in node.inputs:
        if s.identifier == ident:
            return s
    return node.inputs[ident]


def _outp(node, ident):
    for s in node.outputs:
        if s.identifier == ident:
            return s
    return node.outputs[ident]


def _reset(mat, view_hex, rough=0.8, metal=0.0):
    """Wipe node tree → Output + Principled; set viewport display. Returns (nt, bsdf)."""
    if mat.node_tree is None:   # Blender 5.x makes trees by default; legacy datablocks may not
        mat.use_nodes = True    # (deprecated but the only enabler for such blocks)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (380, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (60, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    col = _hex_rgba(view_hex)
    _set(bsdf, "Base Color", col)
    _set(bsdf, "Roughness", rough)
    _set(bsdf, "Metallic", metal)
    mat.diffuse_color = col          # Solid-mode viewport colour (contract)
    mat.roughness = rough
    mat.metallic = metal
    return nt, bsdf


def _math(nt, op, a=None, b=None, loc=(0, 0), clamp=False):
    """Math node; a/b may be constants or output sockets to link."""
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.location = loc
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = float(v)
        elif v is not None:
            nt.links.new(v, n.inputs[i])
    return n


def _ramp(nt, stops, loc=(0, 0), interp="LINEAR"):
    """ColorRamp with exactly `stops` = [(pos, rgba), ...]."""
    n = nt.nodes.new("ShaderNodeValToRGB")
    n.location = loc
    cr = n.color_ramp
    cr.interpolation = interp
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[-1])
    cr.elements[0].position, cr.elements[0].color = stops[0]
    for pos, col in stops[1:]:
        e = cr.elements.new(pos)
        e.color = col
    return n


def _noise(nt, coords, scale, detail=2.0, loc=(0, 0)):
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.location = loc
    _set(n, "Scale", scale)
    _set(n, "Detail", detail)
    if coords is not None:
        nt.links.new(coords, n.inputs["Vector"])
    return n


def _mix(nt, data_type="RGBA", blend="MIX", loc=(0, 0)):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = data_type
    if data_type == "RGBA":
        n.blend_type = blend
    n.location = loc
    return n


def _frame(nt, label, *nodes):
    f = nt.nodes.new("NodeFrame")
    f.label = label
    for n in nodes:
        n.parent = f
    return f


def _rough_noise(nt, bsdf, coords, rough, amp, scale, loc=(-700, -260)):
    """Noise → Map Range → Roughness = rough ± amp (worn-surface breakup)."""
    n = _noise(nt, coords, scale, 2.0, loc)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.location = (loc[0] + 240, loc[1])
    _set(mr, "From Min", 0.0)
    _set(mr, "From Max", 1.0)
    _set(mr, "To Min", rough - amp)
    _set(mr, "To Max", rough + amp)
    nt.links.new(n.outputs["Fac"], _in(mr, "Value"))
    nt.links.new(_outp(mr, "Result"), bsdf.inputs["Roughness"])


# ---- builder factories --------------------------------------------------------

def _plain(hexcol, rough=0.8, metal=0.0):
    """Uniform Principled material."""
    def build(mat):
        _reset(mat, hexcol, rough, metal)
    return build


def _mottled(hexcol, rough, var=0.06, scale=0.08, detail=6.0, rough_var=0.0,
             lo=None, hi=None):
    """Object-space noise → ColorRamp lightness (or lo→hi hue) variation.

    Object coords are metres for the merged city objects (origin, scale 1), so
    `scale` reads as cycles/metre — asphalt's 0.08 ≈ 12 m wear patches.
    """
    def build(mat):
        nt, bsdf = _reset(mat, hexcol, rough)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-980, -40)
        n = _noise(nt, tc.outputs["Object"], scale, detail, (-720, 40))
        stops = [(0.0, _hex_rgba(lo) if lo else _hex_rgba(hexcol, 1.0 - var)),
                 (1.0, _hex_rgba(hi) if hi else _hex_rgba(hexcol, 1.0 + var))]
        ramp = _ramp(nt, stops, (-480, 40))
        nt.links.new(n.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        if rough_var:
            _rough_noise(nt, bsdf, tc.outputs["Object"], rough, rough_var, scale * 6.0)
    return build


def _marking(hexcol, rough=0.75):
    """Road paint: flat colour + slight noise roughness (worn sheen)."""
    def build(mat):
        nt, bsdf = _reset(mat, hexcol, rough)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-980, -260)
        _rough_noise(nt, bsdf, tc.outputs["Object"], rough, 0.05, 0.6)
    return build


def _bricks(hexcol, mortar_hex, row, width, rough, offset=0.5, coords="UV",
            mortar_size=0.02):
    """Brick Texture in UV-metres (Mapping scale 1): row/width are metres.

    sidewalk: 1.2×1.2 aligned concrete slabs; paver: 0.45 rows running bond;
    roof_tile: 0.35 rows (Object coords — roof caps carry no UVs).
    """
    def build(mat):
        nt, bsdf = _reset(mat, hexcol, rough)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-1180, 0)
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.location = (-1000, 0)
        nt.links.new(tc.outputs[coords], mp.inputs["Vector"])
        br = nt.nodes.new("ShaderNodeTexBrick")
        br.location = (-760, 60)
        br.offset = offset            # 0 = aligned grid slabs, 0.5 = running bond
        br.offset_frequency = 2
        br.squash = 1.0
        nt.links.new(mp.outputs["Vector"], br.inputs["Vector"])
        _set(br, "Color1", _hex_rgba(hexcol))
        _set(br, "Color2", _hex_rgba(hexcol, 0.93))   # subtle per-brick variation
        _set(br, "Mortar", _hex_rgba(mortar_hex))
        _set(br, "Scale", 1.0)                         # keep UV metres 1:1
        _set(br, "Mortar Size", mortar_size)
        _set(br, "Mortar Smooth", 0.1)
        _set(br, "Brick Width", width)
        _set(br, "Row Height", row)
        nt.links.new(br.outputs["Color"], bsdf.inputs["Base Color"])
        # mortar recesses read rougher: rough + Fac(1 in mortar) * 0.06
        add = _math(nt, "ADD", rough, None, (-480, -160), clamp=True)
        sc = _math(nt, "MULTIPLY", br.outputs["Fac"], 0.06, (-620, -200))
        nt.links.new(sc.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], bsdf.inputs["Roughness"])
    return build


# ---- photo-PBR layer (Phase 0) --------------------------------------------------
# build.py calls set_textures(texcache.ensure(...)) before materials are built;
# keys present in _TEXTURES get photographic builders (cached as "CB <key> T"),
# everything else keeps the procedural recipes below. Empty dict = fully offline.

_TEXTURES = {}


def set_textures(maps):
    """maps: {key: {"size_m", "color", "normal"?, "rough"?, "ao"?}} from texcache."""
    global _TEXTURES
    _TEXTURES = maps or {}


def _img_node(nt, path, srgb, loc):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = img
    n.extension = "REPEAT"
    n.location = loc
    return n


def _photo_chain(nt, maps, coords="UV", loc=(-1600, 0), value_mul=1.0,
                 tint_hex=None, ao_mix=0.75, normal_strength=1.0):
    """Image-PBR subgraph: returns {"color": socket, "rough": socket?, "normal": socket?}.

    Mapping scale = 1/size_m — UVs and Object coords are both metres, so one
    texture tile spans its real physical size.
    """
    x, y = loc
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (x, y)
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.location = (x + 180, y)
    s = 1.0 / max(0.1, maps.get("size_m", 2.0))
    mp.inputs["Scale"].default_value = (s, s, s)
    nt.links.new(tc.outputs[coords], mp.inputs["Vector"])
    out = {}

    col = _img_node(nt, maps["color"], True, (x + 420, y + 160))
    nt.links.new(mp.outputs["Vector"], col.inputs["Vector"])
    col_socket = col.outputs["Color"]
    if maps.get("ao"):
        ao = _img_node(nt, maps["ao"], False, (x + 420, y + 460))
        nt.links.new(mp.outputs["Vector"], ao.inputs["Vector"])
        m = _mix(nt, "RGBA", "MULTIPLY", (x + 720, y + 260))
        m.label = "AO"
        _in(m, "Factor_Float").default_value = ao_mix
        nt.links.new(col_socket, _in(m, "A_Color"))
        nt.links.new(ao.outputs["Color"], _in(m, "B_Color"))
        col_socket = _outp(m, "Result_Color")
    if tint_hex or value_mul != 1.0:
        t = _mix(nt, "RGBA", "MULTIPLY", (x + 920, y + 160))
        t.label = "tint"
        _in(t, "Factor_Float").default_value = 1.0
        nt.links.new(col_socket, _in(t, "A_Color"))
        _in(t, "B_Color").default_value = _hex_rgba(tint_hex or "#ffffff", value_mul)
        col_socket = _outp(t, "Result_Color")
    out["color"] = col_socket

    if maps.get("rough"):
        rg = _img_node(nt, maps["rough"], False, (x + 420, y - 160))
        nt.links.new(mp.outputs["Vector"], rg.inputs["Vector"])
        out["rough"] = rg.outputs["Color"]
    if maps.get("normal"):
        nm = _img_node(nt, maps["normal"], False, (x + 420, y - 460))
        nt.links.new(mp.outputs["Vector"], nm.inputs["Vector"])
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.location = (x + 720, y - 460)
        _set(nmap, "Strength", normal_strength)
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        out["normal"] = nmap.outputs["Normal"]
    return out


def _asphalt_wear(nt, bsdf, color_socket, loc=(-700, 500)):
    """Wheel-path + oil-band wear multiplied onto the road surface.

    Road sweep UVs: u = lateral metres from the centerline, so |u| < 0.5 is the
    lane-centre oil band and 1.0–2.7 covers wheel paths of a 3.0–3.6 m lane.
    Noise-masked so it reads patchy, not painted. Returns the worn color socket.
    """
    x, y = loc
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (x - 500, y)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (x - 320, y + 60)
    nt.links.new(tc.outputs["UV"], sep.inputs["Vector"])
    au = _math(nt, "ABSOLUTE", sep.outputs["X"], None, (x - 140, y + 60))
    au.label = "|lateral m|"
    patch = _noise(nt, tc.outputs["Object"], 0.05, 3.0, (x - 320, y - 220))
    pmask = _math(nt, "MULTIPLY", patch.outputs["Fac"], 0.9, (x - 140, y - 160))

    oil = _math(nt, "LESS_THAN", au.outputs[0], 0.5, (x + 40, y + 120))
    oil.label = "oil band"
    ofac = _math(nt, "MULTIPLY", oil.outputs[0], pmask.outputs[0], (x + 220, y + 100))
    omix = _mix(nt, "RGBA", "MULTIPLY", (x + 420, y + 80))
    omix.label = "oil dark"
    nt.links.new(ofac.outputs[0], _in(omix, "Factor_Float"))
    nt.links.new(color_socket, _in(omix, "A_Color"))
    _in(omix, "B_Color").default_value = (0.80, 0.80, 0.82, 1.0)

    wlo = _math(nt, "GREATER_THAN", au.outputs[0], 1.0, (x + 40, y - 60))
    whi = _math(nt, "LESS_THAN", au.outputs[0], 2.7, (x + 40, y - 200))
    wband = _math(nt, "MULTIPLY", wlo.outputs[0], whi.outputs[0], (x + 220, y - 120))
    wband.label = "wheel paths"
    wfac = _math(nt, "MULTIPLY", wband.outputs[0], pmask.outputs[0], (x + 400, y - 160))
    wmix = _mix(nt, "RGBA", "MULTIPLY", (x + 620, y - 40))
    wmix.label = "wheel polish (lighter)"
    nt.links.new(wfac.outputs[0], _in(wmix, "Factor_Float"))
    nt.links.new(_outp(omix, "Result_Color"), _in(wmix, "A_Color"))
    _in(wmix, "B_Color").default_value = (1.10, 1.10, 1.09, 1.0)
    return _outp(wmix, "Result_Color")


# per-key photo recipe: viewport hex + options for _photo_chain / wear
_PHOTO_SPECS = {
    "asphalt":       dict(hex="#2a2b2e", coords="UV", wear=True, value_mul=0.7,
                          rough_min=0.8, normal_strength=0.5),
    "asphalt_old":   dict(hex="#242527", coords="UV", value_mul=0.75,
                          rough_min=0.82, normal_strength=0.5),
    "sidewalk":      dict(hex="#9b968c", coords="UV"),
    "paver":         dict(hex="#8a857c", coords="UV"),
    "curb":          dict(hex="#a8a49c", coords="UV", value_mul=0.85),
    "concrete":      dict(hex="#8f8d88", coords="UV", value_mul=0.85),
    "stone":         dict(hex="#b8a883", coords="UV", tint="#c8b795"),
    "roof_tile":     dict(hex="#9a5843", coords="Object", tint="#c07a58"),
    "grass":         dict(hex="#46602c", coords="Object"),
    "forest_floor":  dict(hex="#35471f", coords="Object", value_mul=0.75),
    "gravel":        dict(hex="#8a8478", coords="Object"),
}


def _photo_builder(key, spec):
    """Generic photographic Principled builder for one vocabulary key."""
    def build(mat):
        maps = _TEXTURES[key]
        nt, bsdf = _reset(mat, spec["hex"], 0.9)
        ch = _photo_chain(nt, maps, coords=spec.get("coords", "UV"),
                          loc=(-1600, 0), value_mul=spec.get("value_mul", 1.0),
                          tint_hex=spec.get("tint"),
                          normal_strength=spec.get("normal_strength", 1.0))
        col = ch["color"]
        if spec.get("wear"):
            col = _asphalt_wear(nt, bsdf, col)
        nt.links.new(col, bsdf.inputs["Base Color"])
        if ch.get("rough"):
            rsock = ch["rough"]
            if spec.get("rough_min"):
                clamp = _math(nt, "MAXIMUM", rsock, spec["rough_min"], (-260, -220))
                clamp.label = "roughness floor (no sky mirror)"
                rsock = clamp.outputs[0]
            nt.links.new(rsock, bsdf.inputs["Roughness"])
        if ch.get("normal"):
            nt.links.new(ch["normal"], bsdf.inputs["Normal"])
    return build


# Facade palette: 5 plausible wall colours chosen by the per-face "tint" attr.
_WALL_PALETTE = ("#b8a488", "#a89179", "#c4b49a", "#9a8a80", "#b0a190")
_GLASS_HEX = "#1c2226"
_GLOW_HEX = "#ffd9a0"

# Window band geometry (UV metres): floors every 3.2 m, window 1.0–2.2 m up
# (frac(v/3.2) in 0.31..0.69); columns every 2.6 m, band frac(u/2.6) 0.27..0.73.
_FLOOR_H, _WIN_V0, _WIN_V1 = 3.2, 0.31, 0.69
_COL_W, _WIN_U0, _WIN_U1 = 2.6, 0.27, 0.73
_LIT_THRESHOLD = 0.82   # white-noise gate → ~18% of window cells glow


def _build_wall(mat, photo=None):
    """THE facade: window grid from UV metres + tint palette + lit windows.

    photo = {"plaster": maps, "brick": maps|None} swaps the flat palette for
    photographic wall textures (palette survives as a 30% multiply tint)."""
    nt, bsdf = _reset(mat, _WALL_PALETTE[0], 0.8)
    ln = nt.links.new
    bsdf.location = (240, 0)
    for n in nt.nodes:
        if n.type == "OUTPUT_MATERIAL":
            n.location = (560, 0)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-1960, 40)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-1780, 40)
    ln(tc.outputs["UV"], sep.inputs["Vector"])
    u, v = sep.outputs["X"], sep.outputs["Y"]

    # -- window grid ------------------------------------------------------------
    du = _math(nt, "DIVIDE", u, _COL_W, (-1560, 160))
    du.label = "u / column 2.6m"
    dv = _math(nt, "DIVIDE", v, _FLOOR_H, (-1560, -60))
    dv.label = "v / floor 3.2m"
    fu = _math(nt, "FRACT", du.outputs[0], None, (-1380, 220))
    fv = _math(nt, "FRACT", dv.outputs[0], None, (-1380, -120))
    gu = _math(nt, "GREATER_THAN", fu.outputs[0], _WIN_U0, (-1200, 280))
    lu = _math(nt, "LESS_THAN", fu.outputs[0], _WIN_U1, (-1200, 140))
    bu = _math(nt, "MULTIPLY", gu.outputs[0], lu.outputs[0], (-1020, 220))
    bu.label = "column band"
    gv = _math(nt, "GREATER_THAN", fv.outputs[0], _WIN_V0, (-1200, -60))
    lv = _math(nt, "LESS_THAN", fv.outputs[0], _WIN_V1, (-1200, -200))
    bv = _math(nt, "MULTIPLY", gv.outputs[0], lv.outputs[0], (-1020, -120))
    bv.label = "floor band"
    win = _math(nt, "MULTIPLY", bu.outputs[0], bv.outputs[0], (-840, 60))
    win.label = "window mask"
    _frame(nt, "Window grid (UV metres)", du, dv, fu, fv, gu, lu, bu, gv, lv, bv, win)

    # -- facade palette by tint attribute ----------------------------------------
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "tint"
    at.attribute_type = "GEOMETRY"
    at.location = (-1560, -420)
    pal = _ramp(nt, [(i * 0.2, _hex_rgba(h)) for i, h in enumerate(_WALL_PALETTE)],
                (-1300, -420), interp="CONSTANT")
    pal.label = "facade palette"
    ln(at.outputs["Fac"], pal.inputs["Fac"])
    _frame(nt, "Facade colour (tint attr)", pal)

    # wall colour source: flat palette, or photo wall × palette tint
    wall_col = pal.outputs["Color"]
    if photo:
        pl = _photo_chain(nt, photo["plaster"], coords="UV", loc=(-2400, 700))
        if photo.get("brick"):
            br = _photo_chain(nt, photo["brick"], coords="UV", loc=(-2400, 1150))
            pick = _math(nt, "GREATER_THAN", at.outputs["Fac"], 0.65, (-1400, 760))
            pick.label = "brick if tint > 0.65"
            pmix = _mix(nt, "RGBA", "MIX", (-1180, 820))
            ln(pick.outputs[0], _in(pmix, "Factor_Float"))
            ln(pl["color"], _in(pmix, "A_Color"))
            ln(br["color"], _in(pmix, "B_Color"))
            photo_col = _outp(pmix, "Result_Color")
        else:
            photo_col = pl["color"]
        tintmix = _mix(nt, "RGBA", "MULTIPLY", (-960, 700))
        tintmix.label = "photo × palette (55%)"
        _in(tintmix, "Factor_Float").default_value = 0.55
        ln(photo_col, _in(tintmix, "A_Color"))
        ln(pal.outputs["Color"], _in(tintmix, "B_Color"))
        wall_col = _outp(tintmix, "Result_Color")
        if pl.get("normal"):
            ln(pl["normal"], bsdf.inputs["Normal"])
        _frame(nt, "Photo wall (ambientCG)", tintmix)

    # wall ↔ dark glass by window mask
    colmix = _mix(nt, "RGBA", "MIX", (-560, 40))
    colmix.label = "wall / glass"
    ln(win.outputs[0], _in(colmix, "Factor_Float"))
    ln(wall_col, _in(colmix, "A_Color"))
    _in(colmix, "B_Color").default_value = _hex_rgba(_GLASS_HEX)
    ln(_outp(colmix, "Result_Color"), bsdf.inputs["Base Color"])

    rmix = _mix(nt, "FLOAT", loc=(-560, -220))
    rmix.label = "rough: wall / glass"
    ln(win.outputs[0], _in(rmix, "Factor_Float"))
    _in(rmix, "A_Float").default_value = 0.8    # wall
    _in(rmix, "B_Float").default_value = 0.15   # glass
    ln(_outp(rmix, "Result_Float"), bsdf.inputs["Roughness"])

    # -- lit windows: white noise per window cell ---------------------------------
    flu = _math(nt, "FLOOR", du.outputs[0], None, (-1380, -640))
    flv = _math(nt, "FLOOR", dv.outputs[0], None, (-1380, -800))
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    comb.location = (-1200, -700)
    ln(flu.outputs[0], comb.inputs["X"])
    ln(flv.outputs[0], comb.inputs["Y"])
    wn = nt.nodes.new("ShaderNodeTexWhiteNoise")
    wn.noise_dimensions = "3D"
    wn.location = (-1020, -700)
    ln(comb.outputs["Vector"], wn.inputs["Vector"])
    lit = _math(nt, "GREATER_THAN", wn.outputs["Value"], _LIT_THRESHOLD, (-840, -700))
    lit.label = "~18% cells lit"
    # variety: dimmer for high-tint buildings — (1 − tint·0.5)
    th = _math(nt, "MULTIPLY", at.outputs["Fac"], 0.5, (-840, -880))
    variety = _math(nt, "SUBTRACT", 1.0, None, (-660, -880))
    ln(th.outputs[0], variety.inputs[1])
    gate = _math(nt, "MULTIPLY", win.outputs[0], lit.outputs[0], (-660, -700))
    gate2 = _math(nt, "MULTIPLY", gate.outputs[0], variety.outputs[0], (-480, -760))
    strength = _math(nt, "MULTIPLY", gate2.outputs[0], 2.0, (-300, -760))
    strength.label = "emission strength"
    _set(bsdf, ("Emission Color", "Emission"), _hex_rgba(_GLOW_HEX))
    ln(strength.outputs[0], bsdf.inputs["Emission Strength"])
    _frame(nt, "Lit windows (white noise per cell)",
           flu, flv, comb, wn, lit, th, variety, gate, gate2, strength)


def _build_terrain(mat, photo=None):
    """Grass ↔ rock splat by per-face "rock" attribute + noise breakup.

    photo = {"grass": maps, "rock": maps|None} swaps the flat colours for
    photographic ground textures (Object coords — terrain UVs are metres/8)."""
    grass, rock = "#46602c", "#6f6a5f"
    nt, bsdf = _reset(mat, grass, 1.0)
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "rock"
    at.attribute_type = "GEOMETRY"
    at.location = (-980, 60)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-1220, -220)
    n = _noise(nt, tc.outputs["Object"], 0.05, 4.0, (-980, -220))
    # breakup: fac = clamp(rock + (noise − 0.5)·0.6) — softens the per-face steps
    off = _math(nt, "SUBTRACT", n.outputs["Fac"], 0.5, (-740, -220))
    amp = _math(nt, "MULTIPLY", off.outputs[0], 0.6, (-560, -220))
    fac = _math(nt, "ADD", at.outputs["Fac"], None, (-380, -60), clamp=True)
    nt.links.new(amp.outputs[0], fac.inputs[1])
    mx = _mix(nt, "RGBA", "MIX", (-180, 60))
    mx.label = "grass / rock"
    nt.links.new(fac.outputs[0], _in(mx, "Factor_Float"))
    if photo:
        g = _photo_chain(nt, photo["grass"], coords="Object", loc=(-2200, 400))
        nt.links.new(g["color"], _in(mx, "A_Color"))
        if g.get("normal"):
            nt.links.new(g["normal"], bsdf.inputs["Normal"])
        if photo.get("rock"):
            r = _photo_chain(nt, photo["rock"], coords="Object", loc=(-2200, 850))
            nt.links.new(r["color"], _in(mx, "B_Color"))
        else:
            _in(mx, "B_Color").default_value = _hex_rgba(rock)
    else:
        _in(mx, "A_Color").default_value = _hex_rgba(grass)
        _in(mx, "B_Color").default_value = _hex_rgba(rock)
    nt.links.new(_outp(mx, "Result_Color"), bsdf.inputs["Base Color"])


def _build_water(mat):
    """Dark gloss + noise-bump ripples; slight transmission when socket exists."""
    nt, bsdf = _reset(mat, "#12293c", 0.06)
    _set(bsdf, "IOR", 1.33)
    _set(bsdf, ("Transmission Weight", "Transmission"), 0.3)  # skipped if absent
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-940, -160)
    n = _noise(nt, tc.outputs["Object"], 0.5, 4.0, (-700, -160))
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (-420, -160)
    _set(bump, "Strength", 0.15)
    nt.links.new(n.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def _build_lamp_head(mat):
    """Warm emissive lamp lens."""
    nt, bsdf = _reset(mat, "#fff2d0", 0.4)
    _set(bsdf, ("Emission Color", "Emission"), _hex_rgba("#fff2d0"))
    _set(bsdf, "Emission Strength", 3.0)


# ---- registry -----------------------------------------------------------------
# SPEC.md fixed vocabulary + lamp_head/sign_red/sign_white/landmark_steel.

MATERIALS = {
    "asphalt":        ("Asphalt",         _mottled("#232427", 0.90, var=0.06, scale=0.08, detail=6, rough_var=0.05)),
    "asphalt_old":    ("Asphalt (worn)",  _mottled("#2c2c2e", 0.92, var=0.11, scale=0.08, detail=6, rough_var=0.05)),
    "marking_white":  ("Marking white",   _marking("#f2f1ea", 0.75)),
    "marking_yellow": ("Marking yellow",  _marking("#e6c23e", 0.75)),
    "curb":           ("Curb",            _plain("#a8a49c", 0.85)),
    "sidewalk":       ("Sidewalk slabs",  _bricks("#9b968c", "#7e7a72", row=1.2, width=1.2, rough=0.90, offset=0.0)),
    "paver":          ("Pavers",          _bricks("#8a857c", "#6e6a62", row=0.45, width=0.9, rough=0.90, offset=0.5)),
    "gravel":         ("Gravel",          _mottled("#8a8478", 0.95, var=0.12, scale=0.5, detail=5)),
    "building_wall":  ("Facade",          _build_wall),
    "building_glass": ("Facade glass",    _plain("#22303a", 0.10, metal=0.5)),
    "roof_flat":      ("Roof flat",       _mottled("#4a4a4c", 0.95, var=0.06, scale=0.15, detail=4)),
    "roof_tile":      ("Roof tiles",      _bricks("#9a5843", "#7c4335", row=0.35, width=0.7, rough=0.80, offset=0.5, coords="Object")),
    "roof_metal":     ("Roof metal",      _plain("#6a7075", 0.40, metal=0.6)),
    "water":          ("Water",           _build_water),
    "grass":          ("Grass",           _mottled("#46602c", 1.0, var=0.10, scale=0.15, detail=4)),
    "forest_floor":   ("Forest floor",    _mottled("#35471f", 1.0, var=0.10, scale=0.15, detail=4)),
    "sand":           ("Sand",            _mottled("#cbb98a", 1.0, var=0.05, scale=0.3, detail=3)),
    "terrain":        ("Terrain splat",   _build_terrain),
    "bark":           ("Bark",            _plain("#4a3626", 0.90)),
    "leaves":         ("Leaves",          _mottled("#3c6023", 0.70, scale=0.5, detail=3, lo="#35571f", hi="#476b26")),
    "metal":          ("Metal",           _plain("#8b8f93", 0.55, metal=0.6)),
    "metal_dark":     ("Metal dark",      _plain("#3a3d40", 0.50, metal=0.7)),
    "wood":           ("Wood",            _plain("#7a5a38", 0.80)),
    "concrete":       ("Concrete",        _plain("#8f8d88", 0.90)),
    "stone":          ("Stone",           _plain("#b8a883", 0.92)),
    # beyond the SPEC vocabulary (props + landmarks):
    "lamp_head":      ("Lamp head",       _build_lamp_head),
    "sign_red":       ("Sign red",        _plain("#b71c1c", 0.50)),
    "sign_white":     ("Sign white",      _plain("#f5f5f2", 0.50)),
    "landmark_steel": ("Landmark steel",  _plain("#9a9ea3", 0.55, metal=0.45)),
}


# ---- public API ---------------------------------------------------------------

def _tint(mat, hexcol):
    """Retint Base Color (painted steel etc.). Unlinked socket → set directly;
    node-driven colour → route through a Mix so procedural variation survives."""
    rgba = _hex_rgba(hexcol)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = bsdf.inputs["Base Color"]
    if base.is_linked:
        src = base.links[0].from_socket
        mx = _mix(nt=mat.node_tree, data_type="RGBA", blend="MIX",
                  loc=(bsdf.location[0] - 220, bsdf.location[1] + 260))
        mx.label = "tint override"
        _in(mx, "Factor_Float").default_value = 0.85
        mat.node_tree.links.new(src, _in(mx, "A_Color"))
        _in(mx, "B_Color").default_value = rgba
        mat.node_tree.links.new(_outp(mx, "Result_Color"), base)
    else:
        base.default_value = rgba
    mat.diffuse_color = rgba


def _resolve_builder(key):
    """(builder, textured?) — photo builder when its maps are cached."""
    _display, builder = MATERIALS[key]
    if key in _PHOTO_SPECS and key in _TEXTURES:
        return _photo_builder(key, _PHOTO_SPECS[key]), True
    if key == "building_wall" and "building_wall" in _TEXTURES:
        photo = {"plaster": _TEXTURES["building_wall"],
                 "brick": _TEXTURES.get("building_brick")}
        return (lambda mat: _build_wall(mat, photo=photo)), True
    if key == "terrain" and "terrain" in _TEXTURES:
        photo = {"grass": _TEXTURES["terrain"],
                 "rock": _TEXTURES.get("terrain_rock")}
        return (lambda mat: _build_terrain(mat, photo=photo)), True
    return builder, False


def get(key, color=None):
    """Material for a vocabulary key, cached as "CB <key>" (rebuilt if the
    datablock exists but lost its Principled graph). color="#rrggbb" returns a
    tinted variant cached as "CB <key> <hex>". When photo textures are active
    (set_textures) the textured variant is cached separately as "CB <key> T"
    so texture-on/off rebuilds never collide."""
    if key not in MATERIALS:
        raise KeyError(f"matlib: unknown material key {key!r}")
    builder, textured = _resolve_builder(key)
    name = (f"CB {key}" + (" T" if textured else "")
            + (f" {_norm_hex(color)}" if color else ""))
    mat = bpy.data.materials.get(name)
    if (mat is not None and mat.node_tree is not None
            and any(n.type == "BSDF_PRINCIPLED" for n in mat.node_tree.nodes)):
        return mat
    if mat is None:
        mat = bpy.data.materials.new(name)
    builder(mat)
    if color:
        _tint(mat, _norm_hex(color))
    return mat


# ---- self-test (run inside Blender: blender -b --factory-startup --python matlib.py)

if __name__ == "__main__":
    SPEC_KEYS = {
        "asphalt", "asphalt_old", "marking_white", "marking_yellow", "curb",
        "sidewalk", "paver", "gravel", "building_wall", "building_glass",
        "roof_flat", "roof_tile", "roof_metal", "water", "grass", "forest_floor",
        "sand", "terrain", "bark", "leaves", "metal", "metal_dark", "wood",
        "concrete", "stone",
    }
    EXTRA_KEYS = {"lamp_head", "sign_red", "sign_white", "landmark_steel"}
    assert set(MATERIALS) == SPEC_KEYS | EXTRA_KEYS, sorted(set(MATERIALS) ^ (SPEC_KEYS | EXTRA_KEYS))

    def principled(m):
        ns = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]
        assert len(ns) == 1, f"{m.name}: {len(ns)} Principled nodes"
        return ns[0]

    for key, (display, _b) in MATERIALS.items():
        m = get(key)
        assert m.name == f"CB {key}"
        assert display
        assert m.node_tree is not None, key
        b = principled(m)
        # exact socket names present on this Blender build
        for sname in ("Base Color", "Roughness", "Metallic", "IOR",
                      "Emission Color", "Emission Strength", "Normal"):
            assert sname in b.inputs, f"{key}: Principled missing socket {sname}"
        out = next(n for n in m.node_tree.nodes if n.type == "OUTPUT_MATERIAL")
        assert out.inputs["Surface"].is_linked, key
        # viewport colour: finite, in range, not the factory default grey
        dc = tuple(m.diffuse_color)
        assert len(dc) == 4 and all(math.isfinite(c) and 0.0 <= c <= 1.0 for c in dc), key
        assert dc[:3] != (0.8, 0.8, 0.8), f"{key}: diffuse_color left at default"

    # caching: identity, and rebuild when the graph was destroyed
    assert get("asphalt") is get("asphalt")
    g = get("grass")
    g.node_tree.nodes.clear()
    g2 = get("grass")
    assert g2 is g and any(n.type == "BSDF_PRINCIPLED" for n in g2.node_tree.nodes)

    # facade invariants
    w = get("building_wall")
    wb = principled(w)
    attrs = [n for n in w.node_tree.nodes if n.type == "ATTRIBUTE"]
    assert any(n.attribute_name == "tint" for n in attrs), "facade lacks tint Attribute"
    assert wb.inputs["Base Color"].is_linked
    assert wb.inputs["Roughness"].is_linked
    assert wb.inputs["Emission Strength"].is_linked, "lit windows not wired"
    assert any(n.type == "TEX_WHITE_NOISE" for n in w.node_tree.nodes)
    ramps = [n for n in w.node_tree.nodes if n.type == "VALTORGB"]
    assert any(len(n.color_ramp.elements) == 5 for n in ramps), "5-colour palette missing"

    # brick materials carry metre-true rows
    for key, row in (("sidewalk", 1.2), ("paver", 0.45), ("roof_tile", 0.35)):
        m = get(key)
        br = next(n for n in m.node_tree.nodes if n.type == "TEX_BRICK")
        assert abs(br.inputs["Row Height"].default_value - row) < 1e-6, key
        assert abs(br.inputs["Scale"].default_value - 1.0) < 1e-6, key

    # water: rippled normal + water IOR
    wa = get("water")
    wab = principled(wa)
    assert wab.inputs["Normal"].is_linked, "water bump not wired"
    assert abs(wab.inputs["IOR"].default_value - 1.33) < 1e-3

    # terrain: rock attribute drives the splat
    t = get("terrain")
    assert any(n.type == "ATTRIBUTE" and n.attribute_name == "rock"
               for n in t.node_tree.nodes)

    # lamp head glows
    lh = principled(get("lamp_head"))
    assert abs(lh.inputs["Emission Strength"].default_value - 3.0) < 1e-6

    # tint variants: unlinked base → direct colour; separate cache entry
    ls = get("landmark_steel", color="#C0362C")
    assert ls.name == "CB landmark_steel #c0362c"
    assert ls is not get("landmark_steel")
    assert ls is get("landmark_steel", color="#c0362c")  # normalised cache hit
    got = tuple(principled(ls).inputs["Base Color"].default_value)[:3]
    want = _hex_rgba("#c0362c")[:3]
    assert all(abs(a - b) < 1e-5 for a, b in zip(got, want))
    # tint on a node-driven colour inserts a Mix and keeps the link
    tw = get("building_wall", color="#ff0000")
    twb = principled(tw)
    assert twb.inputs["Base Color"].is_linked
    assert any(n.type == "MIX" and n.label == "tint override" for n in tw.node_tree.nodes)

    print(f"matlib self-test OK — {len(MATERIALS)} materials on Blender "
          f"{bpy.app.version_string}")
