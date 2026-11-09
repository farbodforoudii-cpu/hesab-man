"""Product catalog: one row per SKU, rebuilt from designs/*.json + output/*/report.json.
SKU = <MODEL>-S<ISO size>-<METAL>     e.g. RG002-S62-AG925
  MODEL : RG### ring band · SG### signet · PD### pendant · ER### earring · BR### bracelet
  METAL : AG925 · AG999 · AU750 (18k) · AU585 (14k)
Business fields (cost, price, stock) are kept between rebuilds; edit them in catalog/products.json.
"""
import json, csv, pathlib, datetime

ROOT = pathlib.Path(__file__).parent
METAL_CODE = {"silver_925": "AG925", "fine_silver_999": "AG999", "gold_18k_yellow": "AU750", "gold_14k_yellow": "AU585"}
BUSINESS = ["status", "qty_in_stock", "metal_cost", "casting_cost", "finishing_cost", "stone_cost", "price", "notes"]


def write():
    out = ROOT / "catalog"; out.mkdir(exist_ok=True)
    jpath = out / "products.json"
    old = {r["sku"]: r for r in json.load(open(jpath))} if jpath.exists() else {}
    rows = []
    for f in sorted((ROOT / "designs").glob("*.json")):
        p = json.load(open(f))
        repf = ROOT / "output" / p["design_id"] / "report.json"
        rep = json.load(open(repf)) if repf.exists() else {}
        sku = f'{p["design_id"]}-{METAL_CODE[p["material"]]}'
        row = {
            "sku": sku, "model_code": p["model_code"], "design_id": p["design_id"],
            "name_fa": p["name_fa"], "name_en": p["name_en"], "collection": p["collection"],
            "type": p["type"], "iso_size": p["iso_size"], "finger": p.get("finger"),
            "metal": p["material"], "stone": p.get("stone"),
            "inner_diameter_mm": rep.get("inner_diameter_mm"), "overall_size_mm": rep.get("overall_size_mm"),
            "min_radial_wall_mm": rep.get("min_radial_wall_mm"), "volume_mm3": rep.get("volume_mm3"),
            "est_weight_g": (rep.get("est_weight_g") or {}).get(p["material"]),
            "watertight": rep.get("watertight"),
            "design_file": f"designs/{f.name}", "stl_file": f'output/{p["design_id"]}/{p["design_id"]}.stl',
            "status": "design", "qty_in_stock": 0, "metal_cost": None, "casting_cost": None,
            "finishing_cost": None, "stone_cost": None, "price": None, "notes": "",
            "updated": datetime.date.today().isoformat(),
        }
        for k in BUSINESS:                       # keep what was entered by hand
            if sku in old and old[sku].get(k) not in (None, "", 0, "design"):
                row[k] = old[sku][k]
        rows.append(row)
    json.dump(rows, open(jpath, "w"), indent=2, ensure_ascii=False)
    with open(out / "products.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    return rows


if __name__ == "__main__":
    for r in write(): print(r["sku"], r["est_weight_g"], r["status"])
