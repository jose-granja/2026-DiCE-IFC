"""Generate `python/shims/pyproj/epsg-crs.json`: the EPSG facts ifc-gherkin-rules asks
pyproj for (GRF002/004/005/007), for the browser's pyproj stand-in.

Run with the pyproj the validation service pins, from its official wheel (which
bundles its own PROJ and EPSG database), so the table is the service's:

    python3.12 -m venv /tmp/projvenv
    /tmp/projvenv/bin/pip install --only-binary=:all: pyproj==3.7.1
    /tmp/projvenv/bin/python validator/tools/gen_epsg_table.py validator/python/shims/pyproj/epsg-crs.json

A pyproj built from source links the system PROJ instead (another EPSG release,
other codes): check the printed `proj`/`epsg` versions.
"""
import json
import sys

import pyproj
from pyproj import CRS
from pyproj.database import get_database_metadata, query_crs_info

PROJECTED, VERTICAL, COMPOUND, GEOGRAPHIC = 1, 2, 4, 8


def describe(crs):
    flags = ((PROJECTED if crs.is_projected else 0) | (VERTICAL if crs.is_vertical else 0)
             | (COMPOUND if crs.is_compound else 0) | (GEOGRAPHIC if crs.is_geographic else 0))
    axes = []
    if crs.coordinate_system is not None:
        axes = [[axis.direction, axis.unit_conversion_factor] for axis in crs.coordinate_system.axis_list]
    return flags, axes


def main(out_path):
    infos = [info for info in query_crs_info(auth_name="EPSG") if info.code.isdigit()]
    table = {}
    for code in sorted({int(info.code) for info in infos}):
        crs = CRS.from_epsg(code)
        flags, axes = describe(crs)
        subs = [list(describe(sub)) for sub in crs.sub_crs_list] if crs.is_compound else []
        table[code] = [flags, axes, subs] if subs else [flags, axes]
    names = {}
    for info in infos:
        names.setdefault(info.name, []).append(int(info.code))
    meta = {
        "pyproj": pyproj.__version__,
        "proj": pyproj.proj_version_str,
        "epsg": get_database_metadata("EPSG.VERSION"),
        "codes": len(table),
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"meta": meta, "crs": table,
                   # Only names that identify one code: pyproj refuses an ambiguous one.
                   "names": {name: codes[0] for name, codes in names.items() if len(codes) == 1}},
                  handle, separators=(",", ":"))
    print(meta)


if __name__ == "__main__":
    main(sys.argv[1])
