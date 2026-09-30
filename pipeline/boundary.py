"""Step 1: the protected-area boundary and the study area inside it.

The boundary comes from one OSM relation (config `boundary.osm_relation`). If
it can't be fetched or doesn't form a polygon, the pipeline stops. It never
approximates a boundary.

The study area is optionally cut down by `study_area.split`: the boundary is
split along a river, one side is kept, and a strip either side of the river
itself is kept too.
"""
import json

from pyproj import Transformer
from shapely import ops
from shapely.geometry import LineString, MultiLineString, box, mapping, shape
from shapely.ops import linemerge, polygonize, split, unary_union

from common import DataSourceError, out_dir, overpass, save_json


def _ways_to_lines(elements):
    return [LineString([(p["lon"], p["lat"]) for p in e["geometry"]])
            for e in elements if e["type"] == "way" and len(e.get("geometry", [])) > 1]


def fetch_boundary(cfg):
    rid = cfg["boundary"]["osm_relation"]
    data = overpass(cfg, f"[out:json][timeout:120];rel({rid});out geom;",
                    what=f"boundary (OSM relation {rid})")
    rels = [e for e in data["elements"] if e["type"] == "relation"]
    if not rels:
        raise DataSourceError(f"boundary: OSM relation {rid} not found. "
                              "Supply a GeoJSON boundary instead (config boundary.geojson).")
    rel = rels[0]
    outers = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
              for m in rel["members"] if m["type"] == "way" and m.get("role") in ("outer", "")]
    inners = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
              for m in rel["members"] if m["type"] == "way" and m.get("role") == "inner"]
    outer = unary_union(list(polygonize(unary_union(outers))))
    if outer.is_empty:
        raise DataSourceError(f"boundary: relation {rid}'s outer ways don't close into a polygon. "
                              "Supply a GeoJSON boundary instead.")
    if inners:
        outer = outer.difference(unary_union(list(polygonize(unary_union(inners)))))
    return outer, rel["tags"]


def to_utm(cfg, geom):
    t = Transformer.from_crs("EPSG:4326", cfg["grid"]["crs"], always_xy=True)
    return ops.transform(t.transform, geom)


def to_wgs84(cfg, geom):
    t = Transformer.from_crs(cfg["grid"]["crs"], "EPSG:4326", always_xy=True)
    return ops.transform(t.transform, geom)


def _extend(line, dist):
    """Extend both ends of a line straight out by `dist` (in the line's units)."""
    c = list(line.coords)

    def ext(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = (dx * dx + dy * dy) ** 0.5 or 1
        return (b[0] + dx / n * dist, b[1] + dy / n * dist)

    return LineString([ext(c[1], c[0])] + c + [ext(c[-2], c[-1])])


def study_area(cfg, boundary_utm):
    sp = cfg.get("study_area", {}).get("split")
    if not sp:
        return boundary_utm, None
    minx, miny, maxx, maxy = to_wgs84(cfg, boundary_utm).bounds
    data = overpass(cfg, f"[out:json][timeout:120];{sp['osm_filter']}({miny},{minx},{maxy},{maxx});out geom;",
                    what="study-area split line (river)")
    lines = [to_utm(cfg, l) for l in _ways_to_lines(data["elements"])]
    if not lines:
        raise DataSourceError("study area: no river ways found to split along")
    merged = linemerge(unary_union(lines))
    parts = list(merged.geoms) if isinstance(merged, MultiLineString) else [merged]
    river = max(parts, key=lambda l: l.intersection(boundary_utm).length)
    inside = river.intersection(boundary_utm).length
    if inside < 1000:
        raise DataSourceError(f"study area: the split river only runs {inside:.0f} m inside the boundary")
    # Extend the river straight out past the boundary so it cuts right across.
    cutter = _extend(river, 50_000)
    pieces = split(boundary_utm, cutter).geoms
    keep = sp["keep"]  # east / west / north / south
    # Decide each piece's side by comparing it to the river at the same latitude/longitude.
    kept = []
    for p in pieces:
        c = p.representative_point()
        near = cutter.interpolate(cutter.project(c))
        side = {"east": c.x > near.x, "west": c.x < near.x,
                "north": c.y > near.y, "south": c.y < near.y}[keep]
        if side:
            kept.append(p)
    if not kept:
        raise DataSourceError(f"study area: nothing of the boundary lies {keep} of the river")
    # Where the boundary itself follows the river, the split leaves thin slivers
    # between the two lines. Keep only real pieces (at least 5% of the largest).
    biggest = max(p.area for p in kept)
    block = unary_union([p for p in kept if p.area >= 0.05 * biggest])
    strip = river.buffer(sp.get("river_buffer_m", 0)).intersection(boundary_utm)
    if sp.get("river_alongside_only"):
        # Keep the river only where it runs beside the kept side, not stretches beyond it.
        bx0, by0, bx1, by1 = block.bounds
        span = box(bx0 - 1e5, by0, bx1 + 1e5, by1) if keep in ("east", "west") else box(bx0, by0 - 1e5, bx1, by1 + 1e5)
        strip = strip.intersection(span)
    area = unary_union([block, strip])
    if area.geom_type == "MultiPolygon":  # drop specks left by the clip
        area = max(area.geoms, key=lambda g: g.area)
    return area, river.intersection(boundary_utm)


def run(cfg):
    b, tags = fetch_boundary(cfg)
    b_utm = to_utm(cfg, b)
    area, river = study_area(cfg, b_utm)
    out = out_dir(cfg)
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"role": "boundary", **tags}, "geometry": mapping(b)},
        {"type": "Feature", "properties": {"role": "study_area"}, "geometry": mapping(to_wgs84(cfg, area))},
    ]}
    if river is not None:
        fc["features"].append({"type": "Feature", "properties": {"role": "split_line"},
                               "geometry": mapping(to_wgs84(cfg, river))})
    save_json(out / "boundary.geojson", fc)
    print(f"  boundary: {tags.get('name')}  {b_utm.area / 1e6:.0f} km² ({b_utm.area / 4046.86:,.0f} acres)")
    print(f"  study area: {area.area / 1e6:.0f} km² ({area.area / 4046.86:,.0f} acres)")
    return b_utm, area


def load(cfg):
    """Read back the saved boundary and study area in grid (UTM) coordinates."""
    fc = json.loads((out_dir(cfg) / "boundary.geojson").read_text())
    by = {f["properties"]["role"]: shape(f["geometry"]) for f in fc["features"]}
    return to_utm(cfg, by["boundary"]), to_utm(cfg, by["study_area"])
