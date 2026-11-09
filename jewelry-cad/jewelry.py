"""Build one design or all of them.
   python jewelry.py designs/RG002-S62.json      # one
   python jewelry.py all                         # every file in designs/
Output: output/<design_id>/  (STL for the caster, 3DM for Rhino, preview.png, report.json)
"""
import json, sys, pathlib, math
import numpy as np, trimesh, rhino3dm
from designs_lib import BUILDERS
from engine import inner_radius

ROOT = pathlib.Path(__file__).parent
MATERIALS = json.load(open(ROOT / "materials.json"))


def wall_thickness(tm, n=3000):
    """Radial wall thickness: rays from points on the inner (finger) surface straight outward."""
    r = np.hypot(tm.vertices[:, 0], tm.vertices[:, 1])
    inner = tm.vertices[r < r.min() + 0.25]
    if len(inner) > n:
        inner = inner[np.random.default_rng(0).choice(len(inner), n, replace=False)]
    d = inner.copy(); d[:, 2] = 0; d /= np.linalg.norm(d, axis=1)[:, None]
    origins = inner + d * 1e-3
    # step 0.03 mm in from the band edges so a ray never runs exactly along a side face
    origins[:, 2] -= np.sign(origins[:, 2]) * np.minimum(0.03, np.abs(origins[:, 2]))
    loc, idx, _ = tm.ray.intersects_location(origins, d, multiple_hits=False)
    t = np.linalg.norm(loc - origins[idx], axis=1)
    return float(t.min()), float(np.percentile(t, 50))


def validate(tm, p):
    r = np.hypot(tm.vertices[:, 0], tm.vertices[:, 1])
    vol = tm.volume
    wmin, wmed = wall_thickness(tm)
    ext = tm.extents
    return {
        "watertight": bool(tm.is_watertight),
        "winding_consistent": bool(tm.is_winding_consistent),
        "bodies": len(tm.split(only_watertight=False)),
        "inner_diameter_mm": round(2 * r.min(), 2),
        "target_inner_diameter_mm": round(2 * inner_radius(p["iso_size"]), 2),
        "overall_size_mm": [round(float(x), 2) for x in ext],
        "min_radial_wall_mm": round(wmin, 2),
        "median_radial_wall_mm": round(wmed, 2),
        "volume_mm3": round(vol, 1),
        "est_weight_g": {k: round(vol / 1000 * m["density_g_cm3"], 2) for k, m in MATERIALS.items()},
        "note": "Geometry check only. Minimum wall, shrinkage, sprue and stone seat must be confirmed by the caster.",
    }


def export(tm, out, name):
    out.mkdir(parents=True, exist_ok=True)
    tm.export(out / f"{name}.stl")
    f = rhino3dm.File3dm(); f.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Millimeters
    rm = rhino3dm.Mesh()
    for v in tm.vertices: rm.Vertices.Add(*map(float, v))
    for a, b, c in tm.faces: rm.Faces.AddFace(int(a), int(b), int(c))
    rm.Normals.ComputeNormals(); f.Objects.AddMesh(rm); f.Write(str(out / f"{name}.3dm"), 7)


def build(path):
    p = json.load(open(path))
    name = p["design_id"]
    tm = BUILDERS[p["type"]](p)
    out = ROOT / "output" / name
    export(tm, out, name)
    rep = validate(trimesh.load(out / f"{name}.stl"), p)    # check the exported file itself
    json.dump(rep, open(out / "report.json", "w"), indent=1)
    from render import render
    render(out / f"{name}.stl", out / "preview.png", f'{name}  {p["name_en"]}')
    print(name, json.dumps(rep, ensure_ascii=False))
    return p, rep


if __name__ == "__main__":
    paths = sorted((ROOT / "designs").glob("*.json")) if sys.argv[1] == "all" else [pathlib.Path(a) for a in sys.argv[1:]]
    for pth in paths:
        build(pth)
    import catalog; catalog.write()
