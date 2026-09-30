# Data sources

Everything below is fetched by `pipeline/run.py` from public servers, with no accounts or keys.
If any download fails, the pipeline stops with a `DataSourceError`. Nothing is ever substituted
with random or invented data.

⚠ = a licence condition that matters for commercial use.

| Dataset | Used for | Native resolution | Date | Licence |
|---|---|---|---|---|
| OpenStreetMap (via Overpass API) | Boundary (relation 13764596), roads, tracks, rivers, streams, dams, water bodies, wetlands, buildings | Vector | Live snapshot at run time (first run: 30 Sep 2026) | ⚠ **ODbL 1.0.** Commercial use is allowed, but it's **share-alike**: a database derived from OSM (our tile map counts) must be offered under ODbL if it's distributed. Attribution: "© OpenStreetMap contributors". |
| Copernicus DEM GLO-30 (AWS open data) | Elevation, hillshade | 30 m (1 arc-second) | Radar acquired 2011–2015, released 2021 | Free, commercial use included, with attribution: "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" |
| ESA WorldCover 10 m v200 (AWS) | Land cover classes | 10 m | 2021 | CC BY 4.0: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" |
| Meta / WRI High Resolution Canopy Height v1 (AWS, `dataforgood-fb-data`) | Tree and shrub cover, lone trees | ~1.2 m | Imagery mostly 2009–2020, published 2024 | CC BY 4.0: Tolan et al. (2024), *Remote Sensing of Environment* 300 |
| GBIF occurrence search API (counts only) | Which catalogue species are confirmed present, and the top species lists | n/a | Queried at run time | ⚠ **Per-record licences.** In this area: 37,306 CC BY 4.0, 176 CC0, and **12,858 CC BY-NC 4.0 (non-commercial), which we exclude**. CC BY records need dataset citation: before publishing, register a GBIF "derived dataset" DOI. |
| IUCN Red List categories (via the GBIF species API) | Deciding which species are sensitive | n/a | Current at run time | ⚠ **IUCN Red List terms don't allow commercial use without permission.** We only use the category code to decide placement rules. For a commercial release, hard-code the sensitive list in the config (already possible with `sensitive.always`) or get IUCN permission. |
| Sentinel-2 L2A, collection 1 (Earth Search STAC by Element 84, AWS) | **Comparison image only.** Not used to make the map. | 10 m | Scene 11 Jun 2026 (tile 37NBA) | Copernicus Sentinel data terms: free, commercial use included, with attribution: "Contains modified Copernicus Sentinel data 2026" |

## Resampling to the 10 m grid (UTM 37N, EPSG:32637)
- **Elevation:** bilinear from 30 m, so the terrain is smoother than 10 m detail. It's a surface
  model (DSM), so tall tree stands read slightly high.
- **WorldCover:** nearest-neighbour. It's already 10 m, but in a different projection, so
  boundaries may shift by up to one cell.
- **Canopy:** each 10 m cell gets the mean height, the max height, the share of 1 m pixels ≥ 3 m
  (trees) and the share ≥ 1 m (shrubs).
- **OSM lines:** buffered to a nominal width (config `osm.widths_m`) and burned in.

## Known limits (flagged, not hidden)
- **Whistling thorn is under-mapped.** No global dataset maps *Vachellia drepanolobium*.
  "Bushed grassland" is inferred from canopy ≥ 1 m. The canopy model misses much of this short
  (1–3 m), sparse shrub, so large areas that look like whistling-thorn bushland on Sentinel-2 come
  out as open grassland (see `comparison.png`).
- **Habitat preferences are not from GBIF.** Each species' habitat tiles and herd sizes in the
  config are general knowledge. GBIF only confirms the species is recorded in the conservancy.
- **The GBIF plant lists are dominated by lodge-garden ornamentals.** Wild grasses and shrubs are
  barely recorded (1–4 records each).
- **Sensitive species.** No occurrence records (and so no coordinates) are downloaded for any
  species. Rhinos and every VU/EN/CR species are marked `random_in_habitat`.
