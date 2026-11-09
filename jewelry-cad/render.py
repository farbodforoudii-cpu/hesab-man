"""Quick shaded preview (3 views) of an STL, for approval on the iPad."""
import sys, numpy as np, trimesh, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def render(stl, png, title=""):
    tm = trimesh.load(stl)
    L = np.array([0.4, 0.8, 0.6]); L /= np.linalg.norm(L)
    sh = np.clip(tm.face_normals @ L, 0, 1) * 0.7 + 0.3
    col = np.c_[0.80 * sh, 0.81 * sh, 0.84 * sh, np.ones_like(sh)]
    fig = plt.figure(figsize=(12, 4.4), dpi=130)
    # views: 3/4 from above-front, top (looking down -Y), side (looking along Z)
    for i, (el, az, vt) in enumerate([(30, 35, "3/4"), (0, 0, "Front (along finger)"), (0, 90, "Side")]):
        ax = fig.add_subplot(1, 3, i + 1, projection="3d")
        ax.add_collection3d(Poly3DCollection(tm.vertices[:, [0, 2, 1]][tm.faces], facecolors=col, linewidths=0))
        b = tm.bounds[:, [0, 2, 1]]; c = b.mean(0); s = (b[1] - b[0]).max() / 2
        ax.set_xlim(c[0] - s, c[0] + s); ax.set_ylim(c[1] - s, c[1] + s); ax.set_zlim(c[2] - s, c[2] + s)
        ax.set_box_aspect((1, 1, 1)); ax.view_init(el, az - 90); ax.set_axis_off(); ax.set_title(vt, fontsize=9)
    fig.suptitle(title, fontsize=11)
    plt.tight_layout(); plt.savefig(png, facecolor="white"); plt.close(fig)


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])
