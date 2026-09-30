"""Shared helpers: config, paths, downloads with retries, and the one error type.

Every fetch goes through here so a failed download always stops the pipeline
with a clear message. Nothing downstream ever fills gaps with made-up data.
"""
import hashlib
import json
import time
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "squarefoot-pipeline/0.1 (research prototype)"


class DataSourceError(RuntimeError):
    """A dataset could not be fetched or is unusable. The pipeline stops."""


def load_config(path):
    with open(path) as f:
        cfg = yaml.safe_load(f)
    cfg["_path"] = str(path)
    return cfg


def cache_dir(cfg, *parts):
    d = ROOT / "data" / "cache" / cfg["id"] / Path(*parts)
    d.mkdir(parents=True, exist_ok=True)
    return d


def out_dir(cfg):
    d = ROOT / "data" / "out" / cfg["id"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def http(method, url, *, what, tries=4, timeout=180, **kw):
    """Request with retries. Raises DataSourceError naming `what` on failure."""
    headers = {"User-Agent": USER_AGENT, **kw.pop("headers", {})}
    last = None
    for i in range(tries):
        try:
            r = requests.request(method, url, headers=headers, timeout=timeout, **kw)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}: {r.text[:200]!r}"
        except requests.RequestException as e:
            last = repr(e)
        time.sleep(3 * (i + 1))
    raise DataSourceError(f"{what}: download failed from {url} ({last})")


OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def overpass(cfg, query, *, what):
    """Run an Overpass query (cached by query text). Tries each mirror in turn."""
    key = hashlib.sha1(query.encode()).hexdigest()[:16]
    cached = cache_dir(cfg, "osm") / f"{key}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    errors = []
    for url in OVERPASS_MIRRORS:
        try:
            r = http("POST", url, what=what, tries=2, data={"data": query})
            data = r.json()
        except (DataSourceError, ValueError) as e:
            errors.append(str(e))
            continue
        if data.get("remark", "").lower().startswith("runtime error"):
            errors.append(f"{url}: {data['remark']}")
            continue
        cached.write_text(json.dumps(data))
        return data
    raise DataSourceError(f"{what}: every Overpass server failed:\n  " + "\n  ".join(errors))


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1))
