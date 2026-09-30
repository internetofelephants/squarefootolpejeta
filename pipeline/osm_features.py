"""Step 3: OpenStreetMap roads, tracks, rivers, water bodies and buildings, burned onto the grid.

Lines are buffered to a width (config `osm.widths_m`) before burning, so a
track is a track even where it's narrower than a 10 m cell. Each feature class
becomes its own boolean mask, and classify.py decides what wins where they overlap.
The raw vectors are kept too (osm.geojson), so the game can draw a minimap.
"""
import numpy as np
from rasterio.features import rasterize
from shapely.geometry import LineString, Polygon, mapping
from shapely.ops import polygonize, unary_union

from boundary import to_utm
from common import cache_dir, out_dir, overpass, save_json

# OSM tag → feature class. The first matching rule wins.
RULES = [
    ("water_body", lambda t: t.get("natural") == "water" or "water" in t or t.get("landuse") == "reservoir"),
    ("wetland", lambda t: t.get("natural") == "wetland"),
    ("dam", lambda t: t.get("waterway") in ("dam", "weir")),
    ("river", lambda t: t.get("waterway") == "river"),
    ("stream", lambda t: t.get("waterway") in ("stream", "canal", "drain", "ditch")),
    ("road", lambda t: t.get("highway") in ("primary", "secondary", "tertiary", "trunk")),
    ("track", lambda t: t.get("highway") in ("track", "unclassified", "service", "residential")),
    ("path", lambda t: t.get("highway") in ("path", "footway")),
    ("building", lambda t: "building" in t),
]


def _query(grid):
    w, s, e, n = grid["bounds_wgs84"]
    bb = f"({s},{w},{n},{e})"
    return (f"[out:json][timeout:180];("
            f"way[highway]{bb};way[waterway]{bb};nwr[natural~\"^(water|wetland)$\"]{bb};"
            f"nwr[water]{bb};nwr[landuse=reservoir]{bb};way[building]{bb};"
            f"node[amenity=watering_place]{bb};node[natural=spring]{bb};"
            f");out geom;")


def _geoms(el):
    """Shapely geometries (lon/lat) for an Overpass `out geom` element."""
    if el["type"] == "way":
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        if len(pts) < 2:
            return []
        if pts[0] == pts[-1] and len(pts) >= 4 and el.get("tags", {}).get("highway") is None \
                and el["tags"].get("waterway") not in ("river", "stream"):
            return [Polygon(pts)]
        return [LineString(pts)]
    if el["type"] == "relation":
        outers = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
                  for m in el.get("members", []) if m["type"] == "way" and m.get("role") == "outer"]
        return list(polygonize(unary_union(outers))) if outers else []
    return []


def run(cfg, grid):
    widths = cfg["osm"]["widths_m"]
    data = overpass(cfg, _query(grid), what="OSM features (roads, water, buildings)")
    feats = {name: [] for name, _ in RULES}
    points = []
    for el in data["elements"]:
        t = el.get("tags", {})
        if el["type"] == "node":
            points.append({"lon": el["lon"], "lat": el["lat"],
                           "kind": "waterhole" if t.get("amenity") == "watering_place" else "spring"})
            continue
        for name, test in RULES:
            if test(t):
                feats[name] += [(g, t) for g in _geoms(el)]
                break

    shape_hw = (grid["height"], grid["width"])
    masks, vec = {}, []
    for name, items in feats.items():
        shapes = []
        for g, t in items:
            gu = to_utm(cfg, g)
            if gu.geom_type == "LineString":
                width = widths.get(name, 6)
                gu = gu.buffer(width / 2, cap_style="flat")
            shapes.append(mapping(gu))
            vec.append({"type": "Feature", "properties": {"class": name, "name": t.get("name")},
                        "geometry": mapping(g)})
        masks[name] = rasterize(shapes, out_shape=shape_hw, transform=grid["transform"],
                                all_touched=name in ("track", "road", "path", "river", "stream"),
                                dtype=np.uint8).astype(bool) if shapes else np.zeros(shape_hw, bool)
        print(f"  osm {name:10s} {len(items):4d} features  {masks[name].sum():7d} cells")

    np.savez_compressed(cache_dir(cfg) / "osm_masks.npz", **masks)
    for p in points:
        vec.append({"type": "Feature", "properties": {"class": p["kind"]},
                    "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}})
    save_json(out_dir(cfg) / "osm.geojson", {"type": "FeatureCollection", "features": vec})
    return masks
