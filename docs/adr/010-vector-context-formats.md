# ADR 010 — Reading vector context formats in the browser

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

The viewer can place a model on the earth, but a model on an empty plane
answers only half the question. "Is this the right height beside its
neighbours", "does it sit inside the plot", "does the road meet it where the
drawing says" all need the surroundings — and the surroundings are published,
by municipalities and mapping agencies, in four formats:

| Format | What it is | Where it comes from |
|---|---|---|
| CityJSON | 3D city objects, JSON | 3D city models |
| GeoJSON | 2D features, JSON | almost all open data portals |
| CityGML / GML | 3D city objects, XML | national mapping agencies |
| GeoPackage | features in a SQLite database | the OGC's answer to the shapefile |

## Decision

**Read all four in the browser, into one shape.**

Every reader produces a `ContextGeometry` — a triangle soup in metres about a
projected origin — and the viewer never learns which format a file was. Adding
a fifth format means writing one function.

The alternative, converting server-side, was never considered seriously: it
would mean uploading the user's surroundings data, and §1 of `AGENTS.md` exists
precisely so that question does not get reopened per feature.

### What each reader has to get right

Recorded because each of these is silent when wrong — the geometry renders, in
the wrong place or the wrong shape, which reads as bad data rather than a bug.

- **GeoJSON is longitude-then-latitude and always WGS84** (RFC 7946 §3.1.1,
  §4). Reversed axes put a Portuguese city off Somalia. A file carrying a `crs`
  member naming anything else is refused rather than reprojected on a guess.
- **GeoJSON is flat**, so footprints carrying a height are **extruded** —
  turning a cadastral layer into massing is the whole reason to read it into a
  3D scene. An explicit `height` beats `building:levels`, and a storey count is
  treated as the approximation it is.
- **CityGML namespaces differ by version** (1.0, 2.0, 3.0) and the GML core
  moved too, so elements are matched on *local name*. A reader keyed on a
  namespace fails on half the files in the wild for no useful reason.
- **A `posList`'s tuple size is declared, not implied.** Reading 3D numbers as
  2D pairs produces geometry that is wrong and still renders.
- **GeoPackage geometry is a GPKG blob wrapping WKB**, not bare WKB. Handing
  the blob to a WKB reader reports "unsupported geometry type 18759", which is
  `"GP"` read as an integer.
- **WKB byte order is per geometry**, including each part of a multi-geometry,
  and dimensionality is encoded two incompatible ways (ISO's thousands, EWKB's
  high bits). Deciding which encoding it is *before* extracting the type is the
  difference between reading a `PointZ` and rejecting type 233.
- **Rings are explicitly closed** in both GML and GeoJSON. Fed to a triangle fan
  unchanged, the repeated closing point produces a degenerate triangle per ring.
  `openRing` removes it once, centrally.

## The new dependency: SQLite as WebAssembly

A GeoPackage is a SQLite database, so reading one needs a SQL engine.
`@sqlite.org/sqlite-wasm` is the official build — 870 kB of WebAssembly, against
24 MB unpacked for `sql.js`.

- **Loaded on demand.** Nothing is fetched until a `.gpkg` is opened; an e2e
  test asserts that opening a GeoJSON pulls no SQLite at all.
- **No `eval`.** Checked before adopting it, because Emscripten glue often
  compiles with `new Function` and this application's CSP refuses that — the
  same check that ruled out the full `cesium` package.
- **Served, not bundled.** Its OPFS VFS contains
  `new Worker(new URL(proxyUri, import.meta.url))` with a runtime-computed URL,
  which fails the Turbopack build outright. The module is copied to
  `public/sqlite/` and imported by URL, so `import.meta.url` is the served path
  and SQLite finds its own `.wasm` beside it. This is the third dependency to
  need that treatment, after MapLibre's worker and Cesium's engine.
- **No file is written.** The bytes are handed to `sqlite3_deserialize` as an
  in-memory database and freed with the connection. Nothing touches OPFS, and
  nothing leaves the tab.

## Consequences

- Four formats, one code path, one set of traps written down.
- Fan triangulation means rings with holes are drawn without their holes.
  Dropping a courtyard is a smaller lie than inventing a wall across it, and
  the alternative is an ear-clipping triangulator — worth adding if anyone
  complains about a real file, not before.
- A GeoPackage's tile pyramids and attribute-only tables are ignored; only
  `data_type = 'features'` is read.
