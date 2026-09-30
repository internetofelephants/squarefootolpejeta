# squarefoot

A pipeline that turns real geographic data for a protected area into a 10 m tile map, and
a retro top-down safari driving game on it. The first place is **Ol Pejeta Conservancy,
Kenya: the part east of the main river** (70 km², about 1,000 × 1,100 tiles).

## Setup (once)
You need [uv](https://docs.astral.sh/uv/), which installs Python 3.12 and the libraries into
a private `.venv/` folder in this project.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Run the pipeline
```bash
uv run pipeline/run.py config/ol_pejeta.yaml
```
The first run downloads about 16 MB and takes ~3 minutes. Downloads are cached in
`data/cache/`, so delete that folder to fetch fresh data. Outputs go to `data/out/ol_pejeta/`:

| File | What |
|---|---|
| `tiles.png` | 8-bit grey, value = tile id (see `legend.json`) |
| `tiles_preview.png` | the same in colour, with hillshade |
| `objects.png` | 1 = lone tree |
| `terrain.png` | R·256+G = elevation in decimetres above `elev_base_m`, B = hillshade |
| `elevation.tif` | elevation in metres, georeferenced (open in QGIS) |
| `mask.png` | 255 inside the study area |
| `boundary.geojson`, `osm.geojson` | vectors for the minimap |
| `species.json` | confirmed species, IUCN status, sensitive flags (no coordinates) |
| `meta.json` | grid size, CRS and origin for converting tiles to lat/lon |
| `comparison.png` | tile map beside Sentinel-2 true colour, for checking |

## Play the game
Serve the project folder (the game reads `data/out/`), then open the game in a browser:
```bash
python3 -m http.server 8420
```
Open http://localhost:8420/game/ (it takes `?place=ol_pejeta&biome=savanna`).

**Controls:** ↑/W accelerate, ↓/S brake and reverse, ←/→ or A/D steer, **M** full map, **Z** zoom out.

- **Driving:** fastest on murram roads and tracks, slower in whistling thorn, slower still in thick
  bush and woodland. Open water and the river stop you, but fords let you cross. The fence at the
  study area's edge keeps you in.
- **Animals:** herds are placed at random in suitable habitat each time the game loads (the herd
  densities are game settings in the config). They wander between grazing spots, and most bolt if
  you drive at them fast.
- **Screen:** the HUD shows real latitude/longitude, elevation, the ground you're on and the
  nearest herd.
- **Art:** all of it is drawn in code. The ground is drawn in 32×32-tile chunks: drawn once,
  cached, and drawn ahead of the car.

## Another place
Copy `config/ol_pejeta.yaml`, change `id`, the OSM boundary relation, the grid CRS (the local UTM
zone), the optional river split, and the species catalogue. The code has nothing place-specific.

## Layout
```
config/            one YAML per place (the only place-specific file)
pipeline/          boundary → rasters → osm_features → classify → species → compare (run.py runs all)
data/cache/        downloads (gitignored)
data/out/<id>/     outputs the game reads
game/              the browser game: main.js (engine), sprites.js (pixel helpers),
                   biomes/savanna.js (all the art; copy it to make another biome pack)
DATA_SOURCES.md    every dataset, resolution, date, licence
```
