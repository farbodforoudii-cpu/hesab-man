"""Classic signet built the way bench jewellers shape one: the head is the convex hull of the
face outline and the upper shank, so the sides run in straight, even lines from the face edge
down into the shank all the way round (cone seen from the side, teardrop seen along the finger).
No step, no vertical drum under the face. Units mm, axis Z = finger, +Y = top."""
import math
import numpy as np, trimesh
from manifold3d import Manifold, Mesh, CrossSection
from engine import inner_radius, phi_of, edge_rows, polar, grid_mesh, taper, ellipse_pts, to_manifold


def _shank(p, r0):
    th = np.linspace(0, 2 * math.pi, 720, endpoint=False)
    phi = phi_of(th)
    v = edge_rows(21)
    W = taper(phi, p["shank_top_width_mm"], p["shank_bottom_width_mm"], p["taper_power"])
    T = taper(phi, p["shank_top_thickness_mm"], p["shank_bottom_thickness_mm"], p["taper_power"])
    Z = v[:, None] * W[None, :] / 2
    R = r0 + T[None, :] * (1 - 0.3 * v[:, None] ** 2)       # domed section
    Ri = np.full_like(R, r0 - 0.3)                           # bore is cut later
    TH = np.broadcast_to(th[None, :], R.shape)
    P = polar(R, TH, Z)
    return grid_mesh(P, polar(Ri, TH, Z)), P, phi


def _bore(r0, k):
    ys = np.linspace(-12, 12, 121)
    pts = [(0.0, ys[0])] + [(r0 + k * min((y / 4.0) ** 2, 1.0), y) for y in ys] + [(0.0, ys[-1])]
    return Manifold.revolve(CrossSection([pts]), 360)


def body(p, face_lift=0.0):
    """Returns (manifold body, H, a, b). face_lift raises the hull top above H (for textured faces)."""
    r0 = inner_radius(p["iso_size"])
    H = r0 + p["head_height_mm"]
    a, b = p["face_length_mm"] / 2, p["face_width_mm"] / 2
    shank_tm, P, phi = _shank(p, r0)
    # upper shank points (pulled 0.03 mm inside so hull and shank never share faces)
    sel = np.abs(phi) <= math.radians(p["hull_span_deg"])
    Q = P[:, sel, :].reshape(-1, 3)
    rq = np.hypot(Q[:, 0], Q[:, 1]); Q[:, 0] *= (rq - 0.03) / rq; Q[:, 1] *= (rq - 0.03) / rq
    top = H + face_lift
    pts = np.vstack([Q, ellipse_pts(a, b, top, 180), ellipse_pts(a, b, top - p["face_rim_mm"], 180)])
    head = Manifold.hull_points(pts)
    m = (to_manifold(shank_tm) + head) - _bore(r0, p["comfort_fit_mm"])
    return m, H, a, b


def to_tm(m):
    mesh = m.to_mesh()
    tm = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    tm = max(tm.split(only_watertight=False), key=lambda x: len(x.faces))
    trimesh.repair.fix_normals(tm)
    return tm


def heightfield_cutter(a, b, H, g_fn, res=0.04, margin=1.2, above=2.0):
    """Closed solid whose underside is the surface y = H - g(x,z): subtracting it carves the face."""
    xs = np.arange(-a - margin, a + margin + res, res); zs = np.arange(-b - margin, b + margin + res, res)
    X, Z = np.meshgrid(xs, zs, indexing="ij")
    Yb = H - g_fn(X, Z)
    nx, nz = X.shape
    bot = np.c_[X.ravel(), Yb.ravel(), Z.ravel()]
    topv = np.c_[X.ravel(), np.full(X.size, H + above), Z.ravel()]
    V = np.vstack([bot, topv]); off = X.size
    i, j = np.meshgrid(np.arange(nx - 1), np.arange(nz - 1), indexing="ij")
    A = (i * nz + j).ravel(); B = (i * nz + j + 1).ravel(); C = ((i + 1) * nz + j + 1).ravel(); D = ((i + 1) * nz + j).ravel()
    F = [np.c_[A, C, B], np.c_[A, D, C], np.c_[A, B, C] + off, np.c_[A, C, D] + off]
    def wall(idx):                                     # side walls along a boundary index path
        k = np.arange(len(idx) - 1); a_, b_ = idx[k], idx[k + 1]
        return [np.c_[a_, b_, b_ + off], np.c_[a_, b_ + off, a_ + off]]
    I = lambda ii, jj: ii * nz + jj
    for path in [I(0, np.arange(nz)), I(np.arange(nx), nz - 1), I(nx - 1, np.arange(nz)[::-1]), I(np.arange(nx)[::-1], 0)]:
        F += wall(path)
    tm = trimesh.Trimesh(V, np.vstack(F), process=True); trimesh.repair.fix_normals(tm)
    return to_manifold(tm)
