"""Jewelry CAD engine — shared geometry helpers. Units: mm. Ring axis = Z (finger), top of ring = +Y."""
import math
import numpy as np, trimesh
from manifold3d import Manifold, Mesh, CrossSection

def inner_radius(iso_size):
    """ISO 8653: ring size = inner circumference in mm."""
    return iso_size / (2 * math.pi)

def phi_of(th):
    """Angle from the top of the ring (θ=90°), wrapped to [-π, π]."""
    return (th - math.pi / 2 + math.pi) % (2 * math.pi) - math.pi

def theta_samples(n_dense, n_coarse, dense_half_angle_deg):
    """Angles around the ring: dense near the top (where the detail is), coarse underneath."""
    a = math.radians(dense_half_angle_deg)
    top = np.linspace(-a, a, n_dense, endpoint=False)
    bottom = np.linspace(a, 2 * math.pi - a, n_coarse, endpoint=False)
    return np.sort((np.r_[top, bottom] + math.pi / 2) % (2 * math.pi))

def edge_rows(n):
    """Rows across the band width, v in [-1, 1], denser near both edges."""
    return np.sin(np.linspace(-1, 1, n) * math.pi / 2)

def polar(r, th, z):
    return np.stack([r * np.cos(th), r * np.sin(th), z], -1)

def grid_mesh(P, Q):
    """Closed ring solid from outer/inner point grids [rows across width, columns around ring, 3]."""
    nv, nt, _ = P.shape
    V = np.vstack([P.reshape(-1, 3), Q.reshape(-1, 3)])
    off = nv * nt
    i, j = np.meshgrid(np.arange(nv - 1), np.arange(nt), indexing="ij")
    a, b = (i * nt + j).ravel(), (i * nt + (j + 1) % nt).ravel()
    c, d = ((i + 1) * nt + (j + 1) % nt).ravel(), ((i + 1) * nt + j).ravel()
    F = [np.c_[a, b, c], np.c_[a, c, d], np.c_[a, c, b] + off, np.c_[a, d, c] + off]
    j = np.arange(nt); a, b = j, (j + 1) % nt
    F += [np.c_[a, a + off, b], np.c_[b, a + off, b + off]]
    a, b = (nv - 1) * nt + j, (nv - 1) * nt + (j + 1) % nt
    F += [np.c_[a, b, a + off], np.c_[b, b + off, a + off]]
    tm = trimesh.Trimesh(V, np.vstack(F), process=True)
    trimesh.repair.fix_normals(tm)
    return tm

def comfort_inner(r_in0, z, half_width, k):
    """Comfort-fit bore: r_in0 at the centre line, opening by k at the edges."""
    return r_in0 + k * (z / half_width) ** 2

def edge_chamfer(z, half_width, c):
    """Radial reduction that makes a 45° chamfer of size c on both outer edges."""
    return np.minimum(0, (half_width - np.abs(z)) - c)

def taper(phi, top, bottom, power=1.5):
    """Value that is `top` at the top of the ring and `bottom` underneath, smooth in between."""
    b = ((1 + np.cos(phi)) / 2) ** power
    return bottom + (top - bottom) * b

def ribs(q, pitch, sharp=0.6):
    """Rounded ribs with V grooves: 1 on a rib crest, 0 at the bottom of a groove."""
    return np.abs(np.cos(math.pi * q / pitch)) ** sharp

# ---- manifold (boolean) helpers, used for signet heads ----
def to_manifold(tm):
    return Manifold(Mesh(vert_properties=np.asarray(tm.vertices, np.float32),
                         tri_verts=np.asarray(tm.faces, np.uint32)))

def to_trimesh(man):
    m = man.to_mesh()
    return trimesh.Trimesh(m.vert_properties[:, :3], m.tri_verts, process=True)

def ellipse_pts(a, b, y, n=128):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.c_[a * np.cos(t), np.full(n, y), b * np.sin(t)]

def bore(r_in0, half_width, k, length):
    """Finger-hole cutter (comfort fit) as a solid of revolution around Z."""
    ys = np.linspace(-length / 2, length / 2, 81)
    hw = max(half_width, 1e-6)
    pts = [(0.0, ys[0])] + [(r_in0 + k * min((y / hw) ** 2, 1.0), y) for y in ys] + [(0.0, ys[-1])]
    return Manifold.revolve(CrossSection([pts]), 256)

def cyl_y(radius, y0, y1, seg=128):
    """Cylinder along +Y from y0 to y1, centred on the Y axis."""
    return Manifold.cylinder(y1 - y0, radius, radius, seg).rotate((-90, 0, 0)).translate((0, y0, 0))
