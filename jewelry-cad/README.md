# jewelry-cad

Parametric jewelry models (mm) for resin printing + casting. Separate project from hesab-man.

## Run
```
pip install manifold3d trimesh numpy networkx rhino3dm matplotlib
python jewelry.py designs/fluted_band_64.json          # -> output/<name>/ (STL, 3DM, report.json)
python render.py output/<name>/<name>.stl output/<name>/preview.png
```

- `designs/*.json` — one file per design (the source of truth). ISO ring size = inner circumference in mm.
- `report.json` — watertight check, measured dimensions, volume, estimated weight per metal.
- Geometry check only: minimum wall, shrinkage and sprue must be confirmed by the caster.
- STL/3DM are not committed (large); regenerate from the JSON.
