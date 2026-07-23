"""recognizer.py — building look fusion (Buildings v3, PLAN.md §3.4).

Pure module (stdlib + geom only, no bpy). Port of the app's
src/recognizer (priors.ts + descriptor.ts describeFromPriors), adapted to the
plugin's offline pipeline: the fallback chain is

    explicit OSM tags (building:architecture / building:material / roof:shape)
      → landuse zone (graph["zones"] sampler)
        → era / region / climate heuristics (offline lat/lon boxes — the app
          used Nominatim; the plugin must never block on network)
          → deterministic hash (region-weighted facade pool)

recognize(b, ctx) emits one look per building:

    {"facade": plaster|brick|glass|panel,          # wall material family
     "roof":   tile|metal|flat,                    # pitched-roof material class
     "tint":   0..1,                               # facade palette selector
     "storefront": bool,                           # 4.2 m dark-glass ground band
     "balconies": bool,                            # hash-gated, residential ≥ 4 fl
     "style", "era", "confidence"}                 # provenance

Evidence-weighted confidence gates tag-driven vs pool-driven looks exactly
like the app (strong ≥ 0.6). Deterministic: geom.hash01 / vegetation.hash01s
only — same building always resolves the same way.
"""
import math
import re

try:
    from . import geom
    from .vegetation import hash01s
except ImportError:  # direct python3 execution for self-tests
    import geom
    from vegetation import hash01s

__all__ = ["region_climate", "recognize"]

LEVEL_M = 3.2

# ---------------------------------------------------------------------------
# Region + climate from the scene centre (offline boxes; app used Nominatim)
# ---------------------------------------------------------------------------
EU_MASONRY = ("eu-west", "eu-central", "uk")


def region_climate(lat, lon):
    """(region, climate) for a scene centre. Coarse boxes, deterministic."""
    if lat is None or lon is None:
        return "generic", "temperate"
    region = "generic"
    if 49.5 <= lat <= 61.0 and -8.5 <= lon <= 2.0:
        region = "uk"
    elif 35.0 <= lat < 45.5 and -10.0 <= lon <= 30.0:
        region = "eu-south"
    elif 45.5 <= lat <= 56.0 and 8.0 <= lon <= 25.0:
        region = "eu-central"
    elif 45.5 <= lat <= 55.0 and -10.0 <= lon < 8.0:
        region = "eu-west"
    elif 54.0 <= lat <= 71.0 and 4.0 <= lon <= 32.0:
        region = "eu-north"
    elif 24.0 <= lat <= 50.0 and -125.0 <= lon <= -66.0:
        region = "us"
    elif 30.0 <= lat <= 46.0 and 128.0 <= lon <= 146.0:
        region = "jp"

    a = abs(lat)
    if region == "eu-south" or (region == "us" and lon <= -114.0 and 32.0 <= lat <= 42.0):
        climate = "mediterranean"
    elif a < 20.0:
        climate = "tropical"
    elif a < 48.0:
        climate = "temperate"
    elif a < 60.0:
        climate = "continental"
    else:
        climate = "boreal"
    return region, climate


# ---------------------------------------------------------------------------
# Keyword tables (app parity)
# ---------------------------------------------------------------------------
_STYLE_KEYWORDS = [
    (re.compile(r"brutal", re.I), "brutalist-concrete"),
    (re.compile(r"neoclass|classical|greek revival|beaux|palladian", re.I), "neoclassical"),
    (re.compile(r"gothic|romanesque|baroque|renaissance|victorian|edwardian|georgian|"
                r"tudor|art.?nouveau|art.?deco|second empire", re.I), "prewar-masonry"),
    (re.compile(r"modernist|international style|bauhaus|glass|curtain", re.I), "modernist-glass"),
    (re.compile(r"mediterran|spanish|moorish|mission", re.I), "mediterranean"),
    (re.compile(r"industrial|warehouse|factory", re.I), "industrial-shed"),
    (re.compile(r"contemporary|postmodern|high.?tech|deconstruct", re.I), "contemporary-mixed"),
]

RESIDENTIAL_TYPES = frozenset(("house", "residential", "apartments", "detached",
                               "semidetached_house", "terrace", "dormitory", "bungalow"))
INDUSTRIAL_TYPES = frozenset(("industrial", "warehouse", "factory", "manufacture"))
COMMERCIAL_TYPES = frozenset(("commercial", "office", "retail", "supermarket", "hotel"))
CIVIC_TYPES = frozenset(("church", "cathedral", "chapel", "mosque", "temple",
                         "civic", "government", "museum", "university", "palace"))

_MATERIAL_KEYWORDS = [
    (re.compile(r"glass|curtain", re.I), "glass"),
    (re.compile(r"brick", re.I), "brick"),
    (re.compile(r"concrete|reinforced|precast", re.I), "concrete"),
    (re.compile(r"stone|granite|limestone|marble|sandstone", re.I), "stone"),
    (re.compile(r"stucco|plaster|render|cement_render", re.I), "stucco"),
    (re.compile(r"metal|steel|aluminium|aluminum|cladding|corrugated", re.I), "metal"),
    (re.compile(r"wood|timber", re.I), "stucco"),   # no wood set; render stand-in
]

_STYLE_MATERIAL = {
    "modernist-glass": "glass", "corporate-highrise": "glass",
    "brutalist-concrete": "concrete", "prewar-masonry": "brick",
    "neoclassical": "stone", "brick-rowhouse": "brick",
    "mediterranean": "stucco", "industrial-shed": "metal",
    "vernacular-residential": "stucco", "contemporary-mixed": "mixed",
}

_ERA_KEYWORDS = [
    (re.compile(r"gothic|romanesque|baroque|renaissance|neoclass|classical|palladian", re.I), "historic"),
    (re.compile(r"victorian|edwardian|georgian|art.?nouveau|art.?deco|beaux|second empire|tudor", re.I), "prewar"),
    (re.compile(r"modernist|international style|bauhaus|brutal|mid.?century", re.I), "midcentury"),
    (re.compile(r"postmodern", re.I), "modern"),
    (re.compile(r"contemporary|high.?tech|deconstruct|parametric", re.I), "contemporary"),
]

# material class → plugin facade family
_MATERIAL_FACADE = {"concrete": "panel", "brick": "brick", "stone": "plaster",
                    "stucco": "plaster", "metal": "panel"}

# weak-evidence facade pools per region (cumulative weights) — mirrors the
# app's resolver matrix mix so untagged streets keep their brick share
_POOLS = {
    "eu": (("plaster", 0.55), ("brick", 0.90), ("panel", 1.0)),
    "us": (("brick", 0.40), ("panel", 0.70), ("plaster", 1.0)),
    "generic": (("plaster", 0.50), ("brick", 0.75), ("panel", 1.0)),
}


def _pick(pool, h):
    for name, cum in pool:
        if h < cum:
            return name
    return pool[-1][0]


def _first_match(table, *texts):
    hay = " ".join(t for t in texts if t)
    if not hay:
        return None
    for rx, val in table:
        if rx.search(hay):
            return val
    return None


def _style_from_structure(btype, levels, height, region, climate, zone):
    if btype in INDUSTRIAL_TYPES:
        return "industrial-shed"
    if btype in CIVIC_TYPES:
        return "mediterranean" if region == "eu-south" else "neoclassical"
    if levels >= 12:
        return "corporate-highrise" if height >= 90 else "modernist-glass"
    if levels >= 5:
        if btype in COMMERCIAL_TYPES:
            return "modernist-glass"
        return "prewar-masonry" if region in EU_MASONRY else "contemporary-mixed"
    if climate == "mediterranean" or region == "eu-south":
        return "mediterranean"
    if btype in RESIDENTIAL_TYPES or zone == "residential":
        return "brick-rowhouse" if region == "us" else "vernacular-residential"
    if btype in COMMERCIAL_TYPES or zone in ("retail", "commercial"):
        return "contemporary-mixed"
    return "vernacular-residential"


def _roof_from_style(style, levels, height, region, climate):
    """tile | metal | flat — the pitched-roof material class for auto roofs."""
    if levels >= 9 or height > 30:
        return "flat"
    if style == "industrial-shed":
        return "metal"
    if style in ("mediterranean", "brick-rowhouse", "vernacular-residential",
                 "prewar-masonry"):
        return "tile"
    if style == "neoclassical":
        return "tile" if levels <= 3 else "flat"
    return "flat"


def _era_from_structure(style, material):
    if material == "glass":
        return "contemporary"
    if style == "brutalist-concrete":
        return "midcentury"
    if style in ("prewar-masonry", "neoclassical", "brick-rowhouse"):
        return "prewar"
    return "modern"


# ---------------------------------------------------------------------------
# recognize
# ---------------------------------------------------------------------------
def recognize(b, ctx):
    """One building dict (Graph v2) + context → look (module docstring).

    ctx: {"region": str, "climate": str, "zone_at": f(x, y) -> zone}.
    Reads b: btype, architecture, material, roof_shape, height, levels, kind,
    ring, min_height, id — all optional except ring/height/id.
    """
    region = ctx.get("region", "generic")
    climate = ctx.get("climate", "temperate")
    ring = b.get("ring") or ()
    if ring:
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        zone = ctx["zone_at"](cx, cy) if ctx.get("zone_at") else "none"
    else:
        zone = "none"

    bid = b.get("id", 0)
    btype = str(b.get("btype") or "yes")
    height = float(b.get("height") or 8.0)
    lv_tag = b.get("levels")
    levels = int(lv_tag) if lv_tag else max(1, round(height / LEVEL_M))
    arch = b.get("architecture")
    mat_tag = b.get("material")
    shape_tag = str(b.get("roof_shape") or "auto")

    # ---- fusion chain -------------------------------------------------------
    style = (_first_match(_STYLE_KEYWORDS, arch)
             or _style_from_structure(btype, levels, height, region, climate, zone))
    material = _first_match(_MATERIAL_KEYWORDS, mat_tag) or _STYLE_MATERIAL[style]
    era = _first_match(_ERA_KEYWORDS, arch) or _era_from_structure(style, material)

    # evidence-weighted confidence (app numbers)
    if arch:
        conf = 0.8
    else:
        conf = 0.4
        if mat_tag:
            conf += 0.15
        if shape_tag != "auto":
            conf += 0.12
        if btype != "yes":
            conf += 0.1
        if b.get("height_tagged"):
            conf += 0.08
    conf = min(0.95, conf + (hash01s(f"{bid}:conf") - 0.5) * 0.04)
    strong = conf >= 0.6

    # ---- facade -------------------------------------------------------------
    if strong:
        if material == "glass":
            facade = "glass" if height >= 20.0 else "panel"
        elif material == "mixed":
            facade = _pick((("brick", 0.4), ("plaster", 0.8), ("panel", 1.0)),
                           hash01s(f"{bid}:mix"))
        else:
            facade = _MATERIAL_FACADE[material]
    else:
        pool = _POOLS["eu"] if region in EU_MASONRY or region == "eu-south" else \
            _POOLS.get(region, _POOLS["generic"])
        facade = _pick(pool, hash01s(f"{bid}:pool"))
    # the curtain-wall gate is height-hard: h ≥ 40 commercial always reads glass
    if height >= 40.0 and (btype in COMMERCIAL_TYPES or b.get("kind") == "commercial"
                           or zone in ("commercial", "retail")):
        facade = "glass"

    # ---- roof (pitched material class) ---------------------------------------
    if shape_tag in ("gabled", "hipped", "pyramidal"):
        roof = "metal" if (material == "metal" or style == "industrial-shed") else "tile"
    elif shape_tag == "skillion":
        roof = "metal"
    elif shape_tag in ("flat", "dome"):
        roof = "flat"
    else:  # auto
        roof = _roof_from_style(style, levels, height, region, climate)
        if roof != "flat" and (material == "metal" or style == "industrial-shed"):
            roof = "metal"

    # ---- features -------------------------------------------------------------
    commercial_ish = (btype in COMMERCIAL_TYPES or b.get("kind") == "commercial"
                      or zone in ("retail", "commercial"))
    storefront = (commercial_ish and facade != "glass"
                  and height >= 5.2 and not b.get("min_height"))
    residential_ish = (btype in RESIDENTIAL_TYPES or b.get("kind") == "residential"
                       or zone == "residential")
    balc_p = 0.6 if style == "mediterranean" else 0.35
    balconies = (residential_ish and levels >= 4 and facade != "glass"
                 and not b.get("min_height")
                 and hash01s(f"{bid}:balc") < balc_p)

    return {
        "facade": facade, "roof": roof,
        "tint": geom.hash01(bid if isinstance(bid, int) else
                            int(hash01s(str(bid)) * 4294967296)),
        "storefront": storefront, "balconies": balconies,
        "style": style, "era": era, "confidence": round(conf, 3),
    }


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # region/climate boxes hit the presets
    assert region_climate(50.0870, 14.4208) == ("eu-central", "continental")  # Prague
    assert region_climate(51.5055, -0.0754) == ("uk", "continental")          # London
    assert region_climate(37.8199, -122.4783) == ("us", "mediterranean")     # SF
    assert region_climate(40.7580, -73.9855) == ("us", "temperate")          # Manhattan
    assert region_climate(35.6595, 139.7005) == ("jp", "temperate")          # Tokyo
    assert region_climate(41.9, 12.5) == ("eu-south", "mediterranean")       # Rome
    assert region_climate(59.9, 10.75)[0] == "eu-north"                      # Oslo
    assert region_climate(None, None) == ("generic", "temperate")
    print("  region/climate boxes OK")

    none_zone = {"region": "eu-central", "climate": "temperate",
                 "zone_at": lambda x, y: "none"}
    sq = [(0.0, 0.0), (12.0, 0.0), (12.0, 9.0), (0.0, 9.0)]

    def bld(**kw):
        base = {"ring": sq, "height": 9.0, "id": 42, "btype": "yes", "kind": "auto"}
        base.update(kw)
        return base

    # 1. untagged building → weak evidence → pool facade, deterministic
    weak = recognize(bld(), none_zone)
    assert weak["confidence"] < 0.6
    assert weak["facade"] in ("plaster", "brick", "panel")
    assert recognize(bld(), none_zone) == weak
    # eu pool keeps a brick share across ids
    fac = [recognize(bld(id=i), none_zone)["facade"] for i in range(300)]
    assert 0.2 < fac.count("brick") / 300 < 0.5, fac.count("brick")
    print(f"  weak evidence: pool facade ({fac.count('brick')}/300 brick)")

    # 2. explicit material tag wins (strong evidence)
    br = recognize(bld(material="brick", btype="apartments", height_tagged=True,
                       kind="residential"), none_zone)
    assert br["facade"] == "brick" and br["confidence"] >= 0.6
    st = recognize(bld(material="sandstone", btype="apartments",
                       height_tagged=True), none_zone)
    assert st["facade"] == "plaster"
    mt = recognize(bld(material="corrugated steel", btype="warehouse",
                       height_tagged=True), none_zone)
    assert mt["facade"] == "panel" and mt["style"] == "industrial-shed"
    assert mt["roof"] == "metal"
    print("  material tags: brick/stone/metal → brick/plaster/panel+metal roof")

    # 3. glass towers: curtain wall for tall commercial, panel when low
    tower = recognize(bld(btype="office", height=100.0, levels=28,
                          height_tagged=True), none_zone)
    assert tower["facade"] == "glass" and tower["roof"] == "flat"
    assert tower["style"] == "corporate-highrise" and tower["era"] == "contemporary"
    low_glass = recognize(bld(material="glass", height=8.0, btype="retail",
                              height_tagged=True), none_zone)
    assert low_glass["facade"] == "panel"   # too low to read as curtain wall
    # the h≥40 commercial gate is hard even without tags
    hard = recognize(bld(height=55.0, kind="commercial", btype="commercial"),
                     none_zone)
    assert hard["facade"] == "glass"
    print("  curtain wall: 100 m office glass, 8 m shop panel, 55 m gate glass")

    # 4. architecture tag → style + era + strong confidence
    arch = recognize(bld(architecture="baroque"), none_zone)
    assert arch["style"] == "prewar-masonry" and arch["era"] == "historic"
    assert arch["confidence"] >= 0.6 and arch["facade"] == "brick"
    print("  architecture tag: baroque → prewar-masonry/historic/brick")

    # 5. storefront + balconies gating
    retail_zone = {"region": "eu-central", "climate": "temperate",
                   "zone_at": lambda x, y: "retail"}
    shop = recognize(bld(btype="retail", height=9.0, height_tagged=True), retail_zone)
    assert shop["storefront"] is True
    assert recognize(bld(btype="retail", height=4.0), retail_zone)["storefront"] is False
    assert recognize(bld(btype="retail", height=9.0, min_height=3.0),
                     retail_zone)["storefront"] is False
    res_zone = {"region": "eu-central", "climate": "temperate",
                "zone_at": lambda x, y: "residential"}
    balc = [recognize(bld(id=i, btype="apartments", levels=6, height=19.2,
                          kind="residential", height_tagged=True), res_zone)["balconies"]
            for i in range(300)]
    assert 0.2 < sum(balc) / 300 < 0.5, sum(balc)
    assert not recognize(bld(btype="apartments", levels=2, kind="residential"),
                         res_zone)["balconies"]
    print(f"  storefront gates OK; balconies hash-gated ({sum(balc)}/300)")

    # 6. roof material classes
    gab = recognize(bld(roof_shape="gabled", btype="house", height_tagged=True,
                        kind="residential"), none_zone)
    assert gab["roof"] == "tile"
    sk = recognize(bld(roof_shape="skillion", btype="warehouse",
                       height_tagged=True), none_zone)
    assert sk["roof"] == "metal"
    fl = recognize(bld(roof_shape="flat", btype="office", height_tagged=True),
                   none_zone)
    assert fl["roof"] == "flat"
    # Prague vs Manhattan reads differently for the same mid-rise block
    prague = recognize(bld(btype="apartments", levels=6, height=19.2,
                           height_tagged=True), none_zone)
    manhattan = recognize(bld(btype="apartments", levels=6, height=19.2,
                              height_tagged=True),
                          {"region": "us", "climate": "temperate",
                           "zone_at": lambda x, y: "none"})
    assert prague["style"] == "prewar-masonry"
    assert manhattan["style"] == "contemporary-mixed"
    # tint always in [0,1); string ids fine
    t = recognize(bld(id="way/123"), none_zone)
    assert 0.0 <= t["tint"] < 1.0
    print("  roof classes + region divergence OK")

    print("recognizer self-tests OK")
