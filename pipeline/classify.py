"""Step 4: combine the layers into one tile type per 10 m cell, and write the outputs.

Rules are applied in order, each overriding what came before:
  grass → bushed / dense bush (canopy ≥ shrub height) → woodland (canopy ≥ tree height,
  riverine if near a river or stream) → WorldCover bare / farmland / built-up → swamp →
  stream beds → open water → river → paths, tracks, roads (fords where they cross water) →
  buildings.

Outputs in data/out/<id>/:
  tiles.png          8-bit grey, value = tile id (what the game reads)
  tiles_preview.png  the same in legend colours, for looking at
  objects.png        8-bit grey, 1 = lone tree
  terrain.png        RGB: R,G = elevation in decimetres above `elev_base` (R*256+G), B = hillshade
  elevation.tif      float32 metres, georeferenced (for GIS)
  mask.png           255 inside the study area
  legend.json, meta.json
"""
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from scipy.ndimage import distance_transform_edt, gaussian_filter
from pyproj import Transformer
from shapely.geometry import mapping

from common import cache_dir, out_dir, save_json

# ESA WorldCover class codes
WC_TREE, WC_SHRUB, WC_GRASS, WC_CROP, WC_BUILT, WC_BARE, WC_SNOW, WC_WATER, WC_WETLAND = 10, 20, 30, 40, 50, 60, 70, 80, 90


def hillshade(elev, res, azimuth=315, altitude=45, z=1.0):
    gy, gx = np.gradient(elev * z, res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(360 - azimuth + 90), np.radians(altitude)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def run(cfg, grid, area):
    c = cfg["classify"]
    ids = {t["key"]: t["id"] for t in cfg["tiles"]}
    L = np.load(cache_dir(cfg) / "layers.npz")
    M = np.load(cache_dir(cfg) / "osm_masks.npz")
    lc, tree, shrub, chmax = L["lc"], L["tree_frac"], L["shrub_frac"], L["ch_max"]

    t = np.full(lc.shape, ids["grass"], np.uint8)
    t[shrub >= c["bush_sparse_frac"]] = ids["thorn"]
    t[(lc == WC_SHRUB) & (t == ids["grass"])] = ids["thorn"]
    t[shrub >= c["bush_dense_frac"]] = ids["bush"]

    wooded = (tree >= c["woodland_tree_frac"]) | (lc == WC_TREE)
    waterways = M["river"] | M["stream"]
    near_water = distance_transform_edt(~waterways) * grid["res"] <= c["riverine_m"]
    t[wooded & ~near_water] = ids["woodland"]
    t[wooded & near_water] = ids["riverine"]

    t[lc == WC_BARE] = ids["bare"]
    t[lc == WC_BUILT] = ids["bare"]
    t[lc == WC_CROP] = ids["farmland"]
    t[(lc == WC_WETLAND) | M["wetland"]] = ids["swamp"]
    t[M["stream"]] = ids["stream"]
    water = (lc == WC_WATER) | M["water_body"]
    t[water] = ids["water"]
    t[M["river"]] = ids["river"]

    t[M["path"]] = ids["path"]
    t[M["track"]] = ids["track"]
    t[M["road"]] = ids["road"]
    crossing = (M["track"] | M["road"] | M["path"]) & (water | M["river"])
    t[crossing] = ids["ford"]
    t[M["building"]] = ids["built"]

    objects = np.zeros_like(t)
    open_tiles = np.isin(t, [ids["grass"], ids["thorn"], ids["bush"]])
    objects[open_tiles & (chmax >= c["lone_tree_m"])] = 1

    # Terrain: elevation and hillshade.
    elev = L["elev"]
    base = float(np.floor(np.nanmin(elev)))
    dm = np.clip(np.round((elev - base) * 10), 0, 65535).astype(np.uint16)
    # The DEM is a surface model, so bushes and tree stands show up as bumps. Smooth it
    # before shading so the light follows the land, not the vegetation.
    hs = hillshade(gaussian_filter(elev, c.get("hillshade_smooth", 2)), grid["res"], z=c.get("hillshade_z", 3.0))
    terrain = np.dstack([(dm >> 8).astype(np.uint8), (dm & 255).astype(np.uint8),
                         np.round(hs * 255).astype(np.uint8)])

    inside = rasterize([mapping(area)], out_shape=t.shape, transform=grid["transform"], dtype=np.uint8) * 255

    out = out_dir(cfg)
    Image.fromarray(t, "L").save(out / "tiles.png", optimize=True)
    Image.fromarray(objects, "L").save(out / "objects.png", optimize=True)
    Image.fromarray(terrain, "RGB").save(out / "terrain.png", optimize=True)
    Image.fromarray(inside, "L").save(out / "mask.png", optimize=True)
    with rasterio.open(out / "elevation.tif", "w", driver="GTiff", height=elev.shape[0], width=elev.shape[1],
                       count=1, dtype="float32", crs=grid["crs"], transform=grid["transform"],
                       compress="deflate") as dst:
        dst.write(elev, 1)

    save_preview(cfg, t, objects, hs, out / "tiles_preview.png")

    counts = np.bincount(t[inside > 0].ravel(), minlength=256)
    total = counts.sum()
    legend = [{**tt, "share_inside": round(float(counts[tt["id"]] / total), 4)} for tt in cfg["tiles"]]
    save_json(out / "legend.json", legend)
    for tt in legend:
        print(f"  {tt['id']:3d} {tt['name']:40s} {tt['share_inside']:6.1%}")
    print(f"  lone trees: {int(objects[inside > 0].sum())}")

    save_json(out / "meta.json", {
        "id": cfg["id"], "name": cfg["name"], "crs": grid["crs"], "res_m": grid["res"],
        "width": grid["width"], "height": grid["height"],
        "origin": {"x": grid["x0"], "y": grid["y1"], "note": "top-left corner of cell (0,0), in crs metres"},
        "bounds_wgs84": grid["bounds_wgs84"], "corners_wgs84": _corners(grid),
        "elev_base_m": base, "elev_scale": 0.1,
        "files": {"tiles": "tiles.png", "objects": "objects.png", "terrain": "terrain.png",
                  "mask": "mask.png", "legend": "legend.json", "boundary": "boundary.geojson",
                  "osm": "osm.geojson", "species": "species.json"},
    })
    return t


def _corners(grid):
    """[lon, lat] of the grid's outer corners, so the game can interpolate lat/lon in any CRS."""
    t = Transformer.from_crs(grid["crs"], "EPSG:4326", always_xy=True)
    x0, y1, r = grid["x0"], grid["y1"], grid["res"]
    x1, y0 = x0 + grid["width"] * r, y1 - grid["height"] * r
    return {k: list(t.transform(x, y)) for k, (x, y) in
            {"tl": (x0, y1), "tr": (x1, y1), "bl": (x0, y0), "br": (x1, y0)}.items()}


def save_preview(cfg, t, objects, hs, path):
    pal = np.zeros((256, 3), np.uint8)
    for tt in cfg["tiles"]:
        h = tt["color"].lstrip("#")
        pal[tt["id"]] = [int(h[i:i + 2], 16) for i in (0, 2, 4)]
    rgb = pal[t].astype(np.float32)
    rgb *= (0.75 + 0.5 * hs)[..., None]
    rgb[objects == 1] = [40, 60, 25]
    Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").save(path, optimize=True)
