"""Implicit (signed-distance) modelling for organic forms like classic signets.
A signet = tapered shank  ⊕(smooth blend)  head, cut flat on top, minus the finger hole.
The smooth blend gives the concave flare where the shank grows into the face.
Surface is extracted with marching cubes, then lightly decimated. Units: mm. Axis Z = finger, +Y = top."""
import math
import numpy as np, trimesh
from skimage.measure import marching_cubes
import fast_simplification


def smin(a, b, k):
    """Polynomial smooth union (blend radius ~k)."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def taper(phi, top, bottom, power):
    return bottom + (top - bottom) * ((1 + np.cos(phi)) / 2) ** power


def ellipse2(x, z, a, b):
    """Approximate signed distance to an ellipse (a along x, b along z)."""
    return (np.sqrt((x / a) ** 2 + (z / b) ** 2) - 1) * np.minimum(a, b)


def build(p, top_height_fn=None, extra_cut_fn=None, step=0.06):
    r0 = p["iso_size"] / (2 * math.pi)
    H = r0 + p["head_height_mm"]
    a, b = p["face_length_mm"] / 2, p["face_width_mm"] / 2
    R = r0 + max(p["shank_top_thickness_mm"], p["head_height_mm"]) + 1.5
    hz = max(b, p["shank_top_width_mm"] / 2) + 1.0
    xs = np.arange(-R, R + step, step, dtype=np.float32)
    ys = np.arange(-R, H + 0.5, step, dtype=np.float32)
    zs = np.arange(-hz, hz + step, step, dtype=np.float32)
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    rho = np.sqrt(X ** 2 + Y ** 2)
    phi = np.arctan2(X, Y)                                     # 0 at the top
    # --- shank: superelliptic band section, thickness/width grow towards the top
    t = taper(phi, p["shank_top_thickness_mm"], p["shank_bottom_thickness_mm"], p["taper_power"])
    w = taper(phi, p["shank_top_width_mm"], p["shank_bottom_width_mm"], p["taper_power"]) / 2
    c = r0 - p["section_offset"] * t                           # section centre slightly inside the bore
    e = p["section_exponent"]
    shank = ((np.abs(rho - c) / (t * (1 + p["section_offset"]))) ** e + (np.abs(Z) / w) ** e) ** (1 / e) - 1
    shank *= np.minimum(t, w)
    # --- head: frustum under the face (narrows downwards)
    s = np.clip(1 - p["head_taper"] * (H - Y) / p["head_height_mm"], 0.35, 2.5)   # head_taper < 0: head widens downwards
    head = ellipse2(X, Z, a * s, b * s)
    head = np.maximum(head, (r0 - 1.0) - Y)
    d = smin(shank, head, p["blend_mm"])
    # --- flat (or textured) face
    top = H - (top_height_fn(X, Z) if top_height_fn else 0.0)
    d = np.maximum(d, Y - top)
    # --- finger hole (comfort fit)
    rin = r0 + p["comfort_fit_mm"] * np.clip(Z / 4.0, -1, 1) ** 2
    d = np.maximum(d, rin - rho)
    if extra_cut_fn is not None:
        d = np.maximum(d, extra_cut_fn(X, Y, Z, H))   # cutter is positive inside the pocket
    d = np.pad(d, 1, constant_values=1.0)                      # guarantee a closed surface
    v, f, _, _ = marching_cubes(d, 0.0, spacing=(step, step, step))
    v = v - step + np.array([xs[0], ys[0], zs[0]])
    v, f = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int64), target_reduction=p.get("decimate", 0.7))
    tm = trimesh.Trimesh(v, f, process=True)
    # decimation can leave a few zero-area stray triangles: keep the one real solid
    tm = max(tm.split(only_watertight=False), key=lambda m: len(m.faces))
    trimesh.repair.fix_normals(tm)
    return tm
