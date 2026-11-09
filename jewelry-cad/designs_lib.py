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


def _signet_body(p):
    """Tapered shank + conical head with a flat face (ellipse a x b) at height H above centre."""
    r0 = inner_radius(p["iso_size"])
    th = theta_samples(400, 400, 120)
    phi = phi_of(th)
    v = edge_rows(25)
    W = taper(phi, p["shank_top_width_mm"], p["shank_bottom_width_mm"], 2.0)
    T = taper(phi, p["shank_top_thickness_mm"], p["shank_bottom_thickness_mm"], 2.0)
    Z = v[:, None] * W[None, :] / 2
    R = r0 + T[None, :] * (1 - 0.25 * v[:, None] ** 2)
    Ri = comfort_inner(r0, Z, W[None, :] / 2, p["comfort_fit_mm"])
    TH = np.broadcast_to(th[None, :], R.shape)
    shank = to_manifold(grid_mesh(polar(R, TH, Z), polar(Ri, TH, Z)))
    a, b = p["face_length_mm"] / 2, p["face_width_mm"] / 2   # a: around the ring (X), b: along finger (Z)
    H = r0 + p["head_height_mm"]
    pts = np.vstack([ellipse_pts(a, b, H),
                     ellipse_pts(a, b, H - p["face_rim_mm"]),                    # short vertical rim
                     # foot of the head: sits just above the finger hole, buried inside the shank,
                     # so the head's side walls meet the shank surface (no knife-edge at the bore)
                     ellipse_pts(a * p["head_base_scale"], p["shank_top_width_mm"] / 2 * 0.9,
                                 r0 + p["head_base_y_offset_mm"])])
    head = Manifold.hull_points(pts)
    body = shank + head
    return body, H, a, b


def onyx_signet(p):
    """Round signet with a flat seat for a glued flat stone (stone is NOT part of the casting)."""
    body, H, a, b = _signet_body(p)
    seat = cyl_y(p["stone_diameter_mm"] / 2 + p["stone_clearance_mm"], H - p["stone_seat_depth_mm"], H + 1)
    return to_trimesh(body - seat)


def sunburst_signet(p):
    """Oval signet with radial V grooves from a small centre dome."""
    body, H, a, b = _signet_body(p)
    n, d, wv = p["ray_count"], p["ray_depth_mm"], p["ray_width_mm"]
    r_start, L = p["ray_start_mm"], max(a, b) + 1
    rays = []
    for i in range(n):
        g = Manifold.hull_points(np.array([
            [r_start, H + 0.5, -wv / 2], [r_start, H + 0.5, wv / 2], [L, H + 0.5, -wv / 2], [L, H + 0.5, wv / 2],
            [r_start, H - d, 0], [L, H - d, 0]]))
        rays.append(g.rotate((0, 360.0 * i / n, 0)))
    rays = Manifold.batch_boolean(rays, __import__("manifold3d").OpType.Add)
    # keep a plain rim: rays only inside the face ellipse shrunk by rim_mm
    rim = p["face_border_mm"]
    clip = Manifold.hull_points(np.vstack([ellipse_pts(a - rim, b - rim, H - 2),
                                           ellipse_pts(a - rim, b - rim, H + 2)]))
    body = body - (rays ^ clip)
    dot = Manifold.sphere(p["center_dot_radius_mm"], 64).translate((0, H - p["center_dot_radius_mm"] + p["center_dot_height_mm"], 0))
    return to_trimesh(body + dot)


BUILDERS = {f.__name__: f for f in [fluted_band, bar_band, diagonal_dome, onyx_signet, sunburst_signet]}
