"""Jewelry CAD engine (mm). Run: python jewelry.py designs/<file>.json"""
import json, math, sys, pathlib
import numpy as np, trimesh, rhino3dm
from manifold3d import CrossSection, Manifold

# g/cm3 — typical values, adjust per caster's alloy
DENSITY = {"silver_925": 10.36, "fine_silver_999": 10.49, "gold_14k_yellow": 13.1, "gold_18k_yellow": 15.6}

def inner_radius(iso_size):
    """ISO ring size = inner circumference in mm."""
    return iso_size / (2 * math.pi)

def tube_mesh(r_out, r_in, th, zs):
    """Closed ring mesh from radius grids r_out[z,θ], r_in[z,θ] (structured, no booleans)."""
    nz, nt = r_out.shape
    def grid(r):
        return np.stack([r * np.cos(th), r * np.sin(th), np.broadcast_to(zs[:, None], r.shape)], -1).reshape(-1, 3)
    V = np.vstack([grid(r_out), grid(r_in)])
    off = nz * nt
    idx = lambda i, j: i * nt + (j % nt)
    F = []
    for i in range(nz - 1):
        for j in range(nt):
            a, b, c, d = idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)
            F += [(a, b, c), (a, c, d)]                                 # outer, faces out
            F += [(a + off, c + off, b + off), (a + off, d + off, c + off)]  # inner, faces in
    for j in range(nt):                                                 # bottom and top annulus
        a, b = idx(0, j), idx(0, j + 1)
        F += [(a, a + off, b), (b, a + off, b + off)]
        a, b = idx(nz - 1, j), idx(nz - 1, j + 1)
        F += [(a, b, a + off), (b, b + off, a + off)]
    tm = trimesh.Trimesh(V, np.array(F), process=True)
    trimesh.repair.fix_normals(tm)
    return tm

def fluted_band(p):
    r_in0 = inner_radius(p["iso_size"])
    w, t, h, n = p["width_mm"], p["base_thickness_mm"], p["rib_height_mm"], p["rib_count"]
    c, k = p["edge_chamfer_mm"], p["comfort_fit_mm"]
    ro = r_in0 + t + h
    th = np.linspace(0, 2 * math.pi, n * 32, endpoint=False)
    # z samples: denser near the edges where the rib ends are rounded
    u = np.linspace(-1, 1, 49)
    zs = (w / 2) * np.sin(u * math.pi / 2)
    rib = np.abs(np.cos(n * th / 2)) ** p["rib_sharpness"]           # 0..1, rounded ribs, V grooves
    # rib ends: height falls to 0 over rib_end_round_mm with a quarter-circle curve,
    # so each rib finishes rounded instead of being cut by the chamfer (no saw-tooth rim)
    e = p.get("rib_end_round_mm", 0.6)
    d = np.clip((np.abs(zs) - (w / 2 - e)) / e, 0, 1)
    h_z = h * np.sqrt(1 - d ** 2)
    r_base = r_in0 + t
    edge = np.minimum(0, (w / 2 - np.abs(zs)) - c)                    # small chamfer on the plain rim
    r_out = (r_base + edge)[:, None] + h_z[:, None] * rib[None, :]
    r_in = np.broadcast_to((r_in0 + k * (2 * zs / w) ** 2)[:, None], r_out.shape)  # comfort fit
    return tube_mesh(r_out, np.array(r_in), th, zs)

BUILDERS = {"fluted_band": fluted_band}

def to_trimesh(man):
    m = man.to_mesh()
    return trimesh.Trimesh(m.vert_properties[:, :3], m.tri_verts)

def validate(tm, p):
    r = np.hypot(tm.vertices[:, 0], tm.vertices[:, 1])
    vol = tm.volume
    return {
        "watertight": bool(tm.is_watertight),
        "winding_consistent": bool(tm.is_winding_consistent),
        "bodies": len(tm.split(only_watertight=False)),
        "inner_diameter_mm": round(2 * r.min(), 3),
        "target_inner_diameter_mm": round(2 * inner_radius(p["iso_size"]), 3),
        "outer_diameter_max_mm": round(2 * r.max(), 3),
        "width_mm": round(float(np.ptp(tm.vertices[:, 2])), 3),
        "min_wall_at_groove_edge_mm": round(p["base_thickness_mm"] - p["comfort_fit_mm"] - p["edge_chamfer_mm"], 3),
        "volume_mm3": round(vol, 1),
        "est_weight_g": {k: round(vol / 1000 * d, 2) for k, d in DENSITY.items()},
        "note": "Geometry check only. Min wall, shrinkage and sprue must be confirmed by the caster.",
    }

def export(tm, out, name):
    out.mkdir(parents=True, exist_ok=True)
    tm.export(out / f"{name}.stl")
    f = rhino3dm.File3dm(); f.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Millimeters
    rm = rhino3dm.Mesh()
    for v in tm.vertices: rm.Vertices.Add(*map(float, v))
    for a, b, c in tm.faces: rm.Faces.AddFace(int(a), int(b), int(c))
    rm.Normals.ComputeNormals(); f.Objects.AddMesh(rm); f.Write(str(out / f"{name}.3dm"), 7)

if __name__ == "__main__":
    p = json.load(open(sys.argv[1]))
    tm = BUILDERS[p["type"]](p)
    out = pathlib.Path(__file__).parent / "output" / p["name"]
    export(tm, out, p["name"])
    rep = validate(trimesh.load(out / f"{p['name']}.stl"), p)  # validate the exported file itself
    json.dump(rep, open(out / "report.json", "w"), indent=1)
    print(json.dumps(rep, indent=1))
