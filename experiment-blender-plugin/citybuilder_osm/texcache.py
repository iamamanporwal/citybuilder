"""Photo-PBR texture cache — ambientCG (CC0) download → disk cache → map paths.

Pure stdlib (urllib + zipfile); the caller passes the cache directory (the
extension user dir in Blender). Everything is best-effort: any failure returns
what IS cached and matlib falls back to procedural materials per missing key.

Attribution shipped in UI/docs: "Textures: ambientCG (CC0)".
"""
import os
import sys
import urllib.request
import zipfile

DOWNLOAD_URL = "https://ambientcg.com/get?file={asset}_{res}-JPG.zip"
USER_AGENT = "citybuilder-blender/0.6 (aman@aganastudios.com)"

# Curated set (API-verified 2026-07-23): material key → asset + physical size (m)
# of one texture tile. Keys not listed here always use procedural materials.
TEXTURE_SET = {
    "asphalt":        {"asset": "Road012A",         "size_m": 3.0},
    "asphalt_old":    {"asset": "Road013A",         "size_m": 3.5},   # worn/cracked pads
    "sidewalk":       {"asset": "PavingStones151",  "size_m": 2.4},
    "paver":          {"asset": "PavingStones138",  "size_m": 2.0},
    "curb":           {"asset": "Concrete034",      "size_m": 3.0},
    "concrete":       {"asset": "Concrete034",      "size_m": 3.0},
    "stone":          {"asset": "Concrete034",      "size_m": 3.0},   # tinted in shader
    "building_wall":  {"asset": "PaintedPlaster017", "size_m": 3.2},
    "building_brick": {"asset": "Bricks104",        "size_m": 2.8},
    "roof_tile":      {"asset": "RoofingTiles013A", "size_m": 2.0},
    "grass":          {"asset": "Grass004",         "size_m": 3.0},
    "forest_floor":   {"asset": "Grass004",         "size_m": 3.0},
    "terrain":        {"asset": "Grass004",         "size_m": 3.0},
    "terrain_rock":   {"asset": "Rock058",          "size_m": 4.0},
    "gravel":         {"asset": "Gravel023",        "size_m": 2.0},
}

# zip member suffix → map slot
_MAP_SUFFIXES = {
    "_Color.jpg": "color",
    "_NormalGL.jpg": "normal",
    "_Roughness.jpg": "rough",
    "_AmbientOcclusion.jpg": "ao",
}


def _asset_dir(cache_dir, asset, res):
    return os.path.join(cache_dir, f"{asset}_{res}")


def _scan_maps(adir):
    """Map-slot paths for an unpacked asset dir, or None if color is missing."""
    maps = {}
    if not os.path.isdir(adir):
        return None
    for fn in os.listdir(adir):
        for suffix, slot in _MAP_SUFFIXES.items():
            if fn.endswith(suffix):
                maps[slot] = os.path.join(adir, fn)
    return maps if "color" in maps else None


def _download_asset(cache_dir, asset, res, timeout_s, log):
    adir = _asset_dir(cache_dir, asset, res)
    maps = _scan_maps(adir)
    if maps:
        return maps  # cached
    url = DOWNLOAD_URL.format(asset=asset, res=res)
    zpath = adir + ".zip"
    os.makedirs(cache_dir, exist_ok=True)
    log(f"[citybuilder] fetching texture {asset} ({res})…")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp, open(zpath, "wb") as f:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    os.makedirs(adir, exist_ok=True)
    with zipfile.ZipFile(zpath) as zf:
        for member in zf.namelist():
            base = os.path.basename(member)
            if any(base.endswith(sfx) for sfx in _MAP_SUFFIXES):
                with zf.open(member) as src, \
                        open(os.path.join(adir, base), "wb") as dst:
                    dst.write(src.read())
    os.remove(zpath)
    return _scan_maps(adir)


def ensure(cache_dir, res="2K", keys=None, timeout_s=60, progress=None):
    """Ensure textures for `keys` (default: all) are cached.

    Returns {material_key: {"size_m": float, "color": path, "normal": path?,
    "rough": path?, "ao": path?}} — only for keys whose color map is available.
    Network failures skip the key (procedural fallback) and never raise.
    """
    out = {}
    wanted = {k: v for k, v in TEXTURE_SET.items() if keys is None or k in keys}
    # download each distinct asset once
    assets = {}
    todo = sorted({v["asset"] for v in wanted.values()})
    for i, asset in enumerate(todo):
        if progress:
            progress(i / max(1, len(todo)), f"texture {asset}")
        try:
            maps = _download_asset(cache_dir, asset, res, timeout_s,
                                   lambda m: print(m, file=sys.stderr))
        except Exception as e:
            print(f"[citybuilder] texture {asset} failed ({e}) — procedural fallback",
                  file=sys.stderr)
            maps = _scan_maps(_asset_dir(cache_dir, asset, res))  # partial cache ok
        if maps:
            assets[asset] = maps
    for key, spec in wanted.items():
        maps = assets.get(spec["asset"])
        if maps:
            out[key] = {"size_m": spec["size_m"], **maps}
    return out


if __name__ == "__main__":
    import io
    import tempfile

    # offline: synthetic zip round-trips through the unpack path
    with tempfile.TemporaryDirectory() as tmp:
        adir = _asset_dir(tmp, "Fake001", "2K")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("Fake001_2K-JPG_Color.jpg", b"jpegdata")
            zf.writestr("Fake001_2K-JPG_NormalGL.jpg", b"jpegdata")
            zf.writestr("Fake001_2K-JPG_Roughness.jpg", b"jpegdata")
            zf.writestr("irrelevant.txt", b"x")
        os.makedirs(adir)
        with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
            for member in zf.namelist():
                base = os.path.basename(member)
                if any(base.endswith(s) for s in _MAP_SUFFIXES):
                    with zf.open(member) as src, open(os.path.join(adir, base), "wb") as dst:
                        dst.write(src.read())
        maps = _scan_maps(adir)
        assert maps and set(maps) == {"color", "normal", "rough"}, maps
        # cached asset short-circuits without network
        got = _download_asset(tmp, "Fake001", "2K", 1, lambda m: None)
        assert got["color"].endswith("_Color.jpg")
    assert set(TEXTURE_SET["asphalt"]) == {"asset", "size_m"}
    print("texcache self-tests OK (offline)")