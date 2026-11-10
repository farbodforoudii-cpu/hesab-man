# jewelry-cad — project memory (read this first)

Owner: Farbod. Silver/gold jewelry business. Separate project from hesab-man (only shares the repo for now).
Language with owner: Persian. Owner works on **iPad only** (Rhino for iPad v9 = view/measure; no scripting).

## Workflow (agreed)
1. Owner sends a reference photo + finger/size → Claude models it in code → sends STL + 3DM + preview **as separate files in chat** (SendUserFile; links do not work well for him).
2. Owner checks in Rhino iPad → asks for changes in words → Claude regenerates.
3. STL goes to the caster (he opens it in MatrixGold/ZBrush, prints resin, casts).
Files are MESH (not NURBS). Owner should not rescale for sizing; regenerate instead.

## Business facts
- Stock: 300 g fine silver 999.9 → alloy to 925 (~324 g) at the caster; ask caster for melt loss.
- Caster deal (how owner has worked so far): owner supplies silver equal to the piece weight, casting labour paid in rial.
  For 925 pieces: fine silver to give = cast weight × 0.925 / 0.9999 (≈ 0.925 × weight); caster adds the 7.5 % alloy.
  Settle on the actual raw-cast weight, not the CAD estimate; melt-loss terms still to be agreed.
- Owner's largest finger (middle) = ISO 64. Estimates: index 62, ring 61 (62 for wide rings), little 56. To be confirmed with a sizer.
- Min wall / shrinkage / stone seat tolerances: NOT confirmed by caster yet. Never call a model "production ready" before that.

## Product codes
SKU = `<MODEL>-S<ISO size>-<METAL>`  e.g. `SG001-S64-AG925`
MODEL: RG### band ring · SG### signet · PD### pendant · ER### earring · BR### bracelet (numbers never reused)
METAL: AG925 · AG999 · AU750 · AU585.  Catalog: `catalog/products.json|csv` (rebuilt by `python jewelry.py all`;
business fields status/qty/costs/price are preserved). Status flow: design → approved → sent_to_caster → cast → finished → in_stock → sold.

| Model | Name | Notes |
|---|---|---|
| RG001 | Fluted Band | v2: rounded rib ends |
| RG002 | Bar Band | flat top panel + grooves each side |
| RG003 | Diagonal Flute Dome | tapered, 35° flutes |
| SG001 | Onyx Signet | v4 hull body, head 2.8; 10 mm flat onyx ≤1.5 mm thick, glued; seat 1.5 mm deep |
| SG002 | Sunburst Oval Signet | v4 hull body, head 2.4; 13x8.5 oval across finger, 36 swirling V facets, centre dome |
| SG003 | Classic Round Signet | v4 slim hull body; 11 mm face, head 2.2, ~6.2 g; plain flat face (engraving-ready), Miansai-style reference |

Owner prefers LOW faces: head height only ~0.4 mm above the shank top thickness (keeps face-to-shank transition gentle).
Signet references owner approved as the target look: shank widens + thickens smoothly into the head,
crisp flat face, teardrop outline seen along the finger. v1 signets (hull head on band) were judged wrong.

## Code
`engine.py` geometry helpers · `designs_lib.py` builders · `designs/*.json` one file per design (source of truth) ·
`jewelry.py` build+validate+export · `catalog.py` · `render.py` ·
`sdf.py` implicit modelling (smooth blend + marching cubes) for organic forms such as signets.
Signets v3 (`hull_signet.py`): head = convex hull of face outline + upper shank (±95°), so sides run straight and even from the
face edge into the shank (cone from the side, teardrop along the finger) — owner rejected both the SDF blend (shank flush with face)
and the 0.3 mm drop (drum under face). Textured faces are carved with a height-field cutter.
Redesign of an unproduced model keeps its code and gets `version` +1. Prefer structured grid meshes (no booleans) —
booleans with coplanar faces gave zero-area slivers that break STL watertightness on re-import.
Validation = watertight, single body, inner diameter vs ISO, radial wall-thickness rays, volume, weight per metal.

## Future
Offline ERP/BI app for the gold/silver business (like hesab-man / Life OS): inventory by SKU, metal ledger
(grams in/out, losses), costing, sales, analytics. Catalog JSON is designed to be imported by it.
