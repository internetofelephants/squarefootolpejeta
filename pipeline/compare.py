"""Step 6: side-by-side check of the tile map against a real Sentinel-2 true-colour image.

The scene comes from the Earth Search STAC catalogue (Sentinel-2 L2A on AWS). It
picks the least cloudy date on which the grid is fully covered (it can take
several Sentinel-2 tiles from the same pass), reads the 10 m `visual` (true
colour) asset and resamples it onto exactly the same grid as the tile map.

Output: comparison.png. The top row is the whole map, with the study area outlined
on both. The bottom rows are zoomed crops (config `compare.zooms`), so rivers,
woodland and tracks can be checked cell by cell.
"""
from collections import defaultdict

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import reproject
from pyproj import Transformer
from shapely.geometry import box, mapping, shape

from common import DataSourceError, cache_dir, http, out_dir

STAC = "https://earth-search.aws.element84.com/v1/search"


def _pick_scene(cfg, grid):
    c = cfg.get("compare", {})
    bb = grid["bounds_wgs84"]
    body = {"collections": [c.get("collection", "sentinel-2-c1-l2a")], "bbox": list(bb),
            "datetime": c.get("datetime", "2023-01-01T00:00:00Z/2026-12-31T00:00:00Z"),
            "query": {"eo:cloud_cover": {"lt": c.get("max_cloud", 5)}}, "limit": 200}
    feats = http("POST", STAC, what="Sentinel-2 scene search", json=body).json().get("features", [])
    if not feats:
        raise DataSourceError("Sentinel-2: no cloud-free scene found for this area and date range")
    need = box(*bb)
    by_date = defaultdict(list)
    for f in feats:
        by_date[f["properties"]["datetime"][:10]].append(f)
    best = None
    for date, items in by_date.items():
        cover = shape(items[0]["geometry"])
        for f in items[1:]:
            cover = cover.union(shape(f["geometry"]))
        if cover.contains(need):
            cloud = max(f["properties"]["eo:cloud_cover"] for f in items)
            if best is None or (cloud, date) < (best[0], best[1]) or (abs(cloud - best[0]) < 0.5 and date > best[1]):
                best = (cloud, date, items)
    if best is None:
        raise DataSourceError("Sentinel-2: no single date fully covers the area without cloud")
    return best


def _read_visual(cfg, grid, items, date):
    cached = cache_dir(cfg, "raw") / f"s2_{date}.npy"
    if cached.exists():
        return np.load(cached)
    rgb = np.zeros((3, grid["height"], grid["width"]), np.uint8)
    for f in items:
        url = f["assets"]["visual"]["href"]
        print(f"  reading Sentinel-2 {f['id']}…")
        try:
            with rasterio.open("/vsicurl/" + url) as s:
                for b in range(3):
                    tmp = np.zeros((grid["height"], grid["width"]), np.uint8)
                    reproject(rasterio.band(s, b + 1), tmp, dst_transform=grid["transform"],
                              dst_crs=grid["crs"], resampling=Resampling.bilinear, dst_nodata=0)
                    fill = rgb[b] == 0
                    rgb[b][fill] = tmp[fill]
        except rasterio.errors.RasterioIOError as e:
            raise DataSourceError(f"Sentinel-2: could not read {url} ({e})")
    if (rgb.max(axis=0) == 0).mean() > 0.001:
        raise DataSourceError("Sentinel-2: the scene leaves part of the grid empty")
    np.save(cached, rgb)
    return rgb


def _stretch(rgb):
    # One stretch for all three bands, so colours stay true (no per-band cast).
    lo, hi = np.percentile(rgb, (0.5, 99.5))
    out = (rgb.astype(np.float32) - lo) / max(hi - lo, 1)
    return (np.clip(out, 0, 1) ** 0.8 * 255).astype(np.uint8).transpose(1, 2, 0)


def _outline(area, grid):
    m = rasterize([mapping(area)], out_shape=(grid["height"], grid["width"]),
                  transform=grid["transform"], dtype=np.uint8).astype(bool)
    edge = m ^ np.roll(m, 1, 0) | m ^ np.roll(m, 1, 1)
    return edge


def _font(size):
    for p in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()


def run(cfg, grid, area):
    cloud, date, items = _pick_scene(cfg, grid)
    print(f"  Sentinel-2 scene: {date}, cloud {cloud:.2f}%, {len(items)} tile(s): "
          + ", ".join(f["id"] for f in items))
    s2 = _stretch(_read_visual(cfg, grid, items, date))
    tiles = np.array(Image.open(out_dir(cfg) / "tiles_preview.png").convert("RGB"))

    edge = _outline(area, grid)
    s2o, tio = s2.copy(), tiles.copy()
    s2o[edge] = tio[edge] = [255, 40, 40]

    W, H = grid["width"], grid["height"]
    gap, head = 16, 40
    zooms = cfg.get("compare", {}).get("zooms", [])
    zoom_px = 500
    canvas_h = head + H + gap + len(zooms) * (zoom_px + head + gap)
    im = Image.new("RGB", (W * 2 + gap * 3, canvas_h), (250, 250, 247))
    d = ImageDraw.Draw(im)
    f_big, f_small = _font(22), _font(15)
    d.text((gap, 8), f"Generated tile map (10 m) — {cfg['name']}", fill=(20, 20, 20), font=f_big)
    d.text((W + 2 * gap, 8), f"Sentinel-2 L2A true colour, {date} (10 m)", fill=(20, 20, 20), font=f_big)
    im.paste(Image.fromarray(tio), (gap, head))
    im.paste(Image.fromarray(s2o), (W + 2 * gap, head))

    y = head + H + gap
    for z in zooms:
        # zoom box: centre in lon/lat, size in metres → cell window
        tx = Transformer.from_crs("EPSG:4326", grid["crs"], always_xy=True)
        cx, cy = tx.transform(z["lon"], z["lat"])
        half = z["size_m"] / 2
        c0 = int((cx - half - grid["x0"]) / grid["res"])
        r0 = int((grid["y1"] - (cy + half)) / grid["res"])
        n = int(z["size_m"] / grid["res"])
        c0, r0 = max(0, min(c0, W - n)), max(0, min(r0, H - n))
        for i, src in enumerate((tiles, s2)):
            crop = Image.fromarray(src[r0:r0 + n, c0:c0 + n]).resize((zoom_px, zoom_px), Image.NEAREST)
            im.paste(crop, (gap + i * (W + gap), y + head))
        d.text((gap, y + 10), f"Zoom: {z['label']} ({z['size_m'] / 1000:g} km across)", fill=(20, 20, 20), font=f_small)
        # mark where the zoom is on the overview
        for ox in (gap, W + 2 * gap):
            d.rectangle([ox + c0, head + r0, ox + c0 + n, head + r0 + n], outline=(255, 255, 255), width=2)
        y += zoom_px + head + gap

    # legend down the right of the zoom rows
    lx, ly = gap + zoom_px + 3 * gap, head + H + gap + head
    d.text((lx, ly - 30), "Legend", fill=(20, 20, 20), font=f_small)
    for t in cfg["tiles"]:
        col = tuple(int(t["color"][i:i + 2], 16) for i in (1, 3, 5))
        d.rectangle([lx, ly, lx + 18, ly + 14], fill=col, outline=(80, 80, 80))
        d.text((lx + 26, ly - 1), t["name"], fill=(30, 30, 30), font=f_small)
        ly += 22
    d.rectangle([lx, ly, lx + 18, ly + 14], fill=(40, 60, 25))
    d.text((lx + 26, ly - 1), "Lone tree (canopy ≥ 5 m)", fill=(30, 30, 30), font=f_small)
    ly += 22
    d.line([lx, ly + 7, lx + 18, ly + 7], fill=(255, 40, 40), width=3)
    d.text((lx + 26, ly - 1), "Study area boundary", fill=(30, 30, 30), font=f_small)

    path = out_dir(cfg) / "comparison.png"
    im.save(path, optimize=True)
    print(f"  wrote {path}")
    return path
