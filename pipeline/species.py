"""Step 5: which species plausibly live here, from GBIF, without any locations.

Only *counts* are asked of GBIF (limit=0 searches, with facets). No occurrence
record, and so no coordinate, is ever downloaded or stored, for any species.

For each animal and plant in the config catalogue:
  - match the name to the GBIF backbone
  - count records inside the area (licences restricted to config `species.licenses`)
  - look up its IUCN Red List category
  - mark it sensitive if the category is in `sensitive.iucn` or its family, genus or
    species is in `sensitive.always`
Catalogue entries with too few records are left out of the game and listed as not confirmed.

Also writes the area's most-recorded mammal, bird and plant species, as a reference
list for extending the catalogue.
"""
import json

from shapely.geometry import shape
from shapely.geometry.polygon import orient

from common import DataSourceError, http, out_dir, save_json

API = "https://api.gbif.org/v1"
CLASSES = {"mammals": 359, "birds": 212, "plants (dicots)": 220, "plants (monocots)": 196}


def _gbif(path, what, **params):
    r = http("GET", f"{API}{path}", what=f"GBIF {what}", params=params, timeout=60)
    try:
        return r.json()
    except ValueError:
        raise DataSourceError(f"GBIF {what}: response wasn't JSON")


def _area_wkt(cfg):
    fc = json.loads((out_dir(cfg) / "boundary.geojson").read_text())
    role = "boundary" if cfg["species"].get("gbif_area") == "boundary" else "study_area"
    g = [shape(f["geometry"]) for f in fc["features"] if f["properties"]["role"] == role][0]
    if g.geom_type == "MultiPolygon":
        g = max(g.geoms, key=lambda p: p.area)
    # GBIF wants counter-clockwise rings and a short WKT.
    return orient(g.simplify(0.002), 1.0).wkt


def _count(wkt, licenses, **filters):
    r = _gbif("/occurrence/search", "occurrence count", geometry=wkt, limit=0,
              license=licenses, **filters)
    return r["count"]


def _entry(item, wkt, sp_cfg, sensitive_names):
    m = _gbif("/species/match", f"name match for {item['scientific']}", name=item["scientific"])
    if m.get("matchType") == "NONE" or "usageKey" not in m:
        return {**item, "gbif_key": None, "records": 0, "note": "name not found in GBIF backbone"}
    key = m.get("acceptedUsageKey", m["usageKey"])
    n = _count(wkt, sp_cfg["licenses"], taxonKey=key)
    iucn = None
    try:
        iucn = _gbif(f"/species/{key}/iucnRedListCategory", "IUCN category").get("code")
    except DataSourceError:
        pass  # not every taxon has one; recorded as unknown
    lineage = {m.get(k) for k in ("family", "genus", "species", "canonicalName", "scientificName")}
    sensitive = bool((iucn and iucn in sp_cfg["sensitive"]["iucn"]) or (lineage & sensitive_names))
    return {**item, "gbif_key": key, "gbif_name": m.get("scientificName"), "rank": m.get("rank"),
            "records": n, "iucn": iucn or "unknown", "sensitive": sensitive,
            "placement": "random_in_habitat" if sensitive else "procedural_by_habitat"}


def run(cfg):
    sp = cfg["species"]
    wkt = _area_wkt(cfg)
    total = _gbif("/occurrence/search", "total count", geometry=wkt, limit=0, facet="license")
    by_license = {c["name"]: c["count"] for c in total["facets"][0]["counts"]} if total["facets"] else {}
    print(f"  GBIF records in area: {total['count']:,}  by licence: {by_license}")

    sensitive_names = set(sp["sensitive"].get("always", []))
    animals, missing = [], []
    for item in sp["catalogue"]:
        e = _entry(item, wkt, sp, sensitive_names)
        (animals if e["records"] >= sp.get("min_records", 1) else missing).append(e)
        flag = " SENSITIVE" if e.get("sensitive") else ""
        print(f"  {e['name']:28s} {e['records']:5d} records  IUCN {e.get('iucn', '?'):7s}{flag}")
    plants = [_entry(p, wkt, sp, set()) for p in sp.get("plants", [])]

    reference = {}
    for label, class_key in CLASSES.items():
        r = _gbif("/occurrence/search", f"{label} list", geometry=wkt, limit=0, license=sp["licenses"],
                  classKey=class_key, facet="speciesKey", facetLimit=40)
        keys = [(c["name"], c["count"]) for c in (r["facets"][0]["counts"] if r["facets"] else [])]
        names = []
        for k, n in keys:
            s = _gbif(f"/species/{k}", "species name")
            names.append({"scientific": s.get("canonicalName"), "vernacular": s.get("vernacularName"), "records": n})
        reference[label] = names

    save_json(out_dir(cfg) / "species.json", {
        "note": "Counts only. No GBIF coordinates were downloaded or stored. Habitats come from the "
                "config catalogue (general species knowledge), not from GBIF.",
        "licenses_counted": sp["licenses"], "records_by_license": by_license,
        "animals": animals, "plants": plants, "not_confirmed": missing, "gbif_top_species": reference,
    })
    if missing:
        print(f"  not confirmed by GBIF (left out): {', '.join(m['name'] for m in missing)}")
