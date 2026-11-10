"""Ring builders. Each takes the design JSON dict and returns a trimesh solid (mm)."""
import math
import numpy as np
from manifold3d import Manifold
from engine import (inner_radius, phi_of, theta_samples, edge_rows, polar, grid_mesh,
                    comfort_inner, edge_chamfer, taper, ribs, to_manifold, to_trimesh,
                    ellipse_pts, bore, cyl_y)


def fluted_band(p):
    """Constant band, rounded ribs all around, rib ends rounded at the edges."""
    r0 = inner_radius(p["iso_size"])
    w, t, h, n = p["width_mm"], p["base_thickness_mm"], p["rib_height_mm"], p["rib_count"]
    th = np.linspace(0, 2 * math.pi, n * 32, endpoint=False)
    z = edge_rows(49) * w / 2
    e = p.get("rib_end_round_mm", 0.6)
    d = np.clip((np.abs(z) - (w / 2 - e)) / e, 0, 1)
    h_z = h * np.sqrt(1 - d ** 2)
    rib = np.abs(np.cos(n * th / 2)) ** p["rib_sharpness"]
    R = (r0 + t + edge_chamfer(z, w / 2, p["edge_chamfer_mm"]))[:, None] + h_z[:, None] * rib[None, :]
    Ri = np.broadcast_to(comfort_inner(r0, z, w / 2, p["comfort_fit_mm"])[:, None], R.shape)
    Z = np.broadcast_to(z[:, None], R.shape)
    return grid_mesh(polar(R, th[None, :], Z), polar(Ri, th[None, :], Z))


def bar_band(p):
    """Flat band with a flat polished top panel and a block of grooves on each side of it."""
    r0 = inner_radius(p["iso_size"])
    w, t = p["width_mm"], p["thickness_mm"]
    Ro = r0 + t
    th = theta_samples(2400, 300, 100)
    z = edge_rows(25) * w / 2
    s = Ro * phi_of(th)                                   # arc length from the top (mm)
    s0 = p["panel_length_mm"] / 2 + p["gap_to_grooves_mm"]
    pitch, ng, gd = p["groove_pitch_mm"], p["grooves_per_side"], p["groove_depth_mm"]
    a = np.abs(s) - s0
    zone = (a >= 0) & (a <= ng * pitch)
    off = np.where(zone, -gd * (1 - ribs(a, pitch, p["rib_sharpness"])), 0.0)
    R = (Ro + edge_chamfer(z, w / 2, p["edge_chamfer_mm"]))[:, None] + off[None, :]
    Z = np.broadcast_to(z[:, None], R.shape)
    P = polar(R, th[None, :], Z)
    # flat top panel: project everything above the plane y=H down onto it
    H = math.sqrt(Ro ** 2 - (p["panel_length_mm"] / 2) ** 2)
    y = P[..., 1]
    k = np.where(y > H, H / np.maximum(y, 1e-9), 1.0)
    P[..., 0] *= k; P[..., 1] *= k
    Ri = np.broadcast_to(comfort_inner(r0, z, w / 2, p["comfort_fit_mm"])[:, None], R.shape)
    return grid_mesh(P, polar(Ri, th[None, :], Z))


def diagonal_dome(p):
    """Tapered domed ring, wide on top, with diagonal rounded flutes over the top."""
    r0 = inner_radius(p["iso_size"])
    th = theta_samples(900, 240, 100)
    phi = phi_of(th)
    v = edge_rows(81)
    W = taper(phi, p["top_width_mm"], p["bottom_width_mm"], p["taper_power"])
    T = taper(phi, p["top_thickness_mm"], p["bottom_thickness_mm"], p["taper_power"])
    Z = v[:, None] * W[None, :] / 2
    dome = 1 - p["dome"] * v[:, None] ** 2                # thinner towards the side edges
    Rm = r0 + T[None, :] * dome
    s = Rm * phi[None, :]                                  # arc length from top
    q = s + Z * math.tan(math.radians(p["flute_angle_deg"]))
    fl = p["flute_depth_mm"] * (ribs(q, p["flute_pitch_mm"], p["rib_sharpness"]) - 1)
    a0, a1 = math.radians(p["flute_full_deg"]), math.radians(p["flute_end_deg"])
    fade = np.clip((a1 - np.abs(phi)) / (a1 - a0), 0, 1)
    fade = fade * fade * (3 - 2 * fade)                    # smoothstep
    e = p.get("flute_end_round", 0.15)
    dv = np.clip((np.abs(v) - (1 - e)) / e, 0, 1)
    R = Rm + fl * fade[None, :] * np.sqrt(1 - dv[:, None] ** 2)
    Ri = comfort_inner(r0, Z, W[None, :] / 2, p["comfort_fit_mm"])
    TH = np.broadcast_to(th[None, :], R.shape)
    return grid_mesh(polar(R, TH, Z), polar(Ri, TH, Z))


import hull_signet as hs


def classic_signet(p):
    """Plain flat face (engraving-ready)."""
    m, H, a, b = hs.body(p)
    return hs.to_tm(m)


def onyx_signet(p):
    """Flat seat for a glued flat stone, leaving an even metal rim (stone is NOT cast)."""
    m, H, a, b = hs.body(p)
    rs = p["stone_diameter_mm"] / 2 + p["stone_clearance_mm"]
    d = p["stone_seat_depth_mm"]
    seat = Manifold.cylinder(d + 1.0, rs, rs, 256).rotate((-90, 0, 0)).translate((0, H - d, 0))
    return hs.to_tm(m - seat)


def sunburst_oval_signet(p):
    """Face cut into swirling V facets that run out to a scalloped edge, small dome in the centre."""
    a, b = p["face_length_mm"] / 2, p["face_width_mm"] / 2
    n, depth, swirl = p["ray_count"], p["ray_depth_mm"], math.radians(p["ray_swirl_deg"])
    rd, hd = p["center_dot_radius_mm"], p["center_dot_height_mm"]
    m, H, a, b = hs.body(p, face_lift=hd + 0.2)
    def g(X, Z):
        r = np.sqrt((X / a) ** 2 + (Z / b) ** 2)
        ang = np.arctan2(Z / b, X / a)
        ph = (ang * n / (2 * math.pi) - swirl * np.minimum(r, 1.2) * n / (2 * math.pi)) % 1.0
        v = 1 - np.abs(2 * ph - 1)                              # 0 ridge .. 1 valley
        ramp = np.clip((r - (rd + 0.3) / min(a, b)) / 0.15, 0, 1)
        rm = np.sqrt(X ** 2 + Z ** 2)
        dot = hd * np.sqrt(np.clip(1 - (rm / rd) ** 2, 0, 1))
        return depth * v * ramp - dot
    return hs.to_tm(m - hs.heightfield_cutter(a, b, H, g))


BUILDERS = {f.__name__: f for f in [fluted_band, bar_band, diagonal_dome, classic_signet, onyx_signet, sunburst_oval_signet]}
