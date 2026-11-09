# jewelry-cad

Parametric jewelry models (mm) for resin printing + casting, plus the product catalog. See `CLAUDE.md`.

```
pip install manifold3d trimesh numpy networkx rtree rhino3dm matplotlib
python jewelry.py all                      # build every design in designs/
python jewelry.py designs/SG001-S64.json   # build one
```
Output per design: `output/<id>/` STL (caster), 3DM (Rhino), preview.png, report.json. STL/3DM are not committed.
