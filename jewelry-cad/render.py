import sys, numpy as np, trimesh, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
tm = trimesh.load(sys.argv[1])
L = np.array([0.4, -0.5, 0.8]); L /= np.linalg.norm(L)
fig = plt.figure(figsize=(12, 4.2), dpi=150)
for i, (el, az, title) in enumerate([(20, -60, "3/4"), (90, -90, "Top"), (0, -90, "Side")]):
    ax = fig.add_subplot(1, 3, i+1, projection="3d")
    shade = np.clip(tm.face_normals @ L, 0, 1)*0.75 + 0.25
    col = np.c_[0.78*shade, 0.80*shade, 0.84*shade, np.ones_like(shade)]
    ax.add_collection3d(Poly3DCollection(tm.triangles, facecolors=col, linewidths=0))
    b = tm.bounds; c = b.mean(0); s = (b[1]-b[0]).max()/2
    ax.set_xlim(c[0]-s, c[0]+s); ax.set_ylim(c[1]-s, c[1]+s); ax.set_zlim(c[2]-s, c[2]+s)
    ax.set_box_aspect((1,1,1)); ax.view_init(el, az); ax.set_axis_off(); ax.set_title(title)
plt.tight_layout(); plt.savefig(sys.argv[2], facecolor="white")
