# Vendored: bpypolyskel

Source: https://github.com/prochitecture/bpypolyskel
Commit: bd1ce5b2e9dc2028595e6a3e116926e1c58e45dd (2026-03-13)
License: GPL-3.0 (see LICENSE in this directory) — compatible with this
extension's SPDX:GPL-3.0-or-later license. Headers kept verbatim.

Used by roofs.py for true straight-skeleton hipped/complex roofs
(`polygonize(verts, firstVertIndex, numVerts, holesInfo, height, tan, faces)`).
Requires mathutils (Blender); plain-python3 self-tests exercise the
inset-ridge fallback instead.
