"""Step 2: the 10 m grid, and the three rasters resampled onto it.

  elevation   Copernicus DEM GLO-30        bilinear
  landcover   ESA WorldCover 10 m v200     nearest (class codes)
  canopy      Meta/WRI canopy height 1 m   mean, max, and tree and shrub fractions per cell

Each source is read straight from its public cloud-optimised GeoTIFFs. Only the
window around the study area is downloaded, and it's cached in data/cache/.
"""
import math

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds

from common import DataSourceError, cache_dir, out_dir, save_json

SOURCES = {
    "dem": {
        "what": "Copernicus DEM GLO-30",
        "tile_deg": 1,
        "url": "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{lat}_00_{lon}_00_DEM/"
               "Copernicus_DSM_COG_10_{lat}_00_{lon}_00_DEM.tif",
        "fmt": lambda la, lo: {"lat": f"{'N' if la >= 0 else 'S'}{abs(la):02d}",
                               "lon": f"{'E' if lo >= 0 else 'W'}{abs(lo):03d}"},
    },
    "worldcover": {
        "what": "ESA WorldCover 10 m 2021 v200",
        "tile_deg": 3,
        "url": "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
               "ESA_WorldCover_10m_2021_v200_{lat}{lon}_Map.tif",
        "fmt": lambda la, lo: {"lat": f"{'N' if la >= 0 else 'S'}{abs(la):02d}",
                               "lon": f"{'E' if lo >= 0 else 'W'}{abs(lo):03d}"},
    },
    "canopy": {
        "what": "Meta/WRI global canopy height 1 m (v1)",
        "url": "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/{qk}.tif",
    },
}


# ---- the grid -------------------------------------------------------------

def make_grid(cfg, area):
    g = cfg["grid"]
    r, m = g["resolution_m"], g["margin_m"]
    x0, y0, x1, y1 = area.bounds
    x0, y0 = math.floor((x0 - m) / r) * r, math.floor((y0 - m) / r) * r
    x1, y1 = math.ceil((x1 + m) / r) * r, math.ceil((y1 + m) / r) * r
    grid = {"crs": g["crs"], "res": r, "x0": x0, "y1": y1,
            "width": int((x1 - x0) / r), "height": int((y1 - y0) / r)}
    grid["transform"] = from_origin(x0, y1, r, r)
    grid["bounds_wgs84"] = transform_bounds(g["crs"], "EPSG:4326", x0, y0, x1, y1)
    return grid


def _blank(grid, dtype, fill=0):
    return np.full((grid["height"], grid["width"]), fill, dtype=dtype)


# ---- which source tiles cover the grid --------------------------------------

def _degree_tiles(src, bounds):
    w, s, e, n = bounds
    d = src["tile_deg"]
    lats = range(math.floor(s / d) * d, math.floor(n / d) * d + 1, d)
    lons = range(math.floor(w / d) * d, math.floor(e / d) * d + 1, d)
    return [src["url"].format(**src["fmt"](la, lo)) for la in lats for lo in lons]


def _quadkey(lon, lat, z):
    lat = max(min(lat, 85.05), -85.05)
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return "".join(str(((x >> i) & 1) + (((y >> i) & 1) << 1)) for i in range(z - 1, -1, -1))


def _canopy_tiles(src, bounds):
    w, s, e, n = bounds
    qks = {_quadkey(w + (e - w) * i / 20, s + (n - s) * j / 20, 9) for i in range(21) for j in range(21)}
    return [src["url"].format(qk=q) for q in sorted(qks)]


# ---- download the window and resample ---------------------------------------

def _fetch_window(cfg, name, urls, bounds_wgs84):
    """Merge the part of each remote tile inside the bounds into one local GeoTIFF."""
    cached = cache_dir(cfg, "raw") / f"{name}.tif"
    if cached.exists():
        return cached
    src_info = SOURCES[name]
    datasets = []
    try:
        for u in urls:
            try:
                datasets.append(rasterio.open("/vsicurl/" + u))
            except rasterio.errors.RasterioIOError as e:
                raise DataSourceError(f"{src_info['what']}: could not open {u} ({e})")
        crs = datasets[0].crs
        b = transform_bounds("EPSG:4326", crs, *bounds_wgs84)
        pad = 3 * abs(datasets[0].res[0])
        b = (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)
        print(f"  downloading {src_info['what']} from {len(urls)} tile(s)…")
        try:
            data, transform = merge(datasets, bounds=b)
        except Exception as e:
            raise DataSourceError(f"{src_info['what']}: reading the window failed ({e})")
        profile = {"driver": "GTiff", "height": data.shape[1], "width": data.shape[2], "count": data.shape[0],
                   "dtype": data.dtype, "crs": crs, "transform": transform, "compress": "deflate",
                   "nodata": datasets[0].nodata}
        with rasterio.open(cached, "w", **profile) as dst:
            dst.write(data)
    finally:
        for d in datasets:
            d.close()
    return cached


def _resample(path, grid, dtype, resampling, *, band_fn=None, src_nodata=None, fill=0):
    dst = _blank(grid, dtype, fill)
    with rasterio.open(path) as s:
        a = s.read(1)
        if band_fn:
            a = band_fn(a)
        reproject(a, dst, src_transform=s.transform, src_crs=s.crs,
                  src_nodata=src_nodata if src_nodata is not None else s.nodata,
                  dst_transform=grid["transform"], dst_crs=grid["crs"], resampling=resampling)
    return dst


def run(cfg, area):
    grid = make_grid(cfg, area)
    bw = grid["bounds_wgs84"]
    print(f"  grid: {grid['width']} × {grid['height']} cells at {grid['res']} m")

    dem_path = _fetch_window(cfg, "dem", _degree_tiles(SOURCES["dem"], bw), bw)
    elev = _resample(dem_path, grid, np.float32, Resampling.bilinear, fill=np.nan)

    wc_path = _fetch_window(cfg, "worldcover", _degree_tiles(SOURCES["worldcover"], bw), bw)
    lc = _resample(wc_path, grid, np.uint8, Resampling.nearest)

    ch_path = _fetch_window(cfg, "canopy", _canopy_tiles(SOURCES["canopy"], bw), bw)
    ch_mean = _resample(ch_path, grid, np.float32, Resampling.average, band_fn=lambda a: a.astype(np.float32))
    ch_max = _resample(ch_path, grid, np.float32, Resampling.max, band_fn=lambda a: a.astype(np.float32))
    c = cfg["classify"]
    tree_frac = _resample(ch_path, grid, np.float32, Resampling.average,
                          band_fn=lambda a: (a >= c["tree_height_m"]).astype(np.float32))
    shrub_frac = _resample(ch_path, grid, np.float32, Resampling.average,
                           band_fn=lambda a: (a >= c["shrub_height_m"]).astype(np.float32))

    # Refuse to carry on with holes: a gap is a failed download, not open ground.
    for nm, arr, bad in [("elevation", elev, np.isnan(elev)), ("land cover", lc, lc == 0)]:
        frac = bad.mean()
        if frac > 0.001:
            raise DataSourceError(f"{nm}: {frac:.1%} of the grid has no data")

    out = out_dir(cfg)
    np.savez_compressed(cache_dir(cfg) / "layers.npz", elev=elev, lc=lc, ch_mean=ch_mean,
                        ch_max=ch_max, tree_frac=tree_frac, shrub_frac=shrub_frac)
    grid_json = {k: v for k, v in grid.items() if k != "transform"}
    save_json(out / "grid.json", grid_json)
    return grid
