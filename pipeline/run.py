"""Run the whole pipeline for one place.

    uv run pipeline/run.py config/ol_pejeta.yaml

Downloads are cached in data/cache/<id>/, so a rerun only redoes the processing.
Delete that folder to fetch everything fresh. Any failed download stops the run
with a DataSourceError. Nothing is ever filled in with invented data.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import boundary  # noqa: E402
import classify  # noqa: E402
import compare  # noqa: E402
import osm_features  # noqa: E402
import rasters  # noqa: E402
import species  # noqa: E402
from common import DataSourceError, load_config, out_dir  # noqa: E402


def main(config_path):
    cfg = load_config(config_path)
    t0 = time.time()
    steps = [
        ("boundary", lambda s: s.update(zip(("boundary", "area"), boundary.run(cfg)))),
        ("rasters", lambda s: s.update(grid=rasters.run(cfg, s["area"]))),
        ("osm features", lambda s: osm_features.run(cfg, s["grid"])),
        ("classify", lambda s: classify.run(cfg, s["grid"], s["area"])),
        ("species", lambda s: species.run(cfg)),
        ("comparison image", lambda s: compare.run(cfg, s["grid"], s["area"])),
    ]
    state = {}
    for name, fn in steps:
        print(f"[{name}]")
        try:
            fn(state)
        except DataSourceError as e:
            print(f"\nSTOPPED at step '{name}': {e}\n"
                  "No substitute data was used. Fix the source (or wait and rerun) and try again.")
            sys.exit(1)
    print(f"done in {time.time() - t0:.0f} s → {out_dir(cfg)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "config/ol_pejeta.yaml")
