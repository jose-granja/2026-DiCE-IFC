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
- GeoPackage and GML use ear-clipping triangulation for concave polygons and
  holes. CityJSON and GeoJSON still use triangle fans.
- A GeoPackage's tile pyramids and attribute-only tables are ignored; only
  `data_type = 'features'` is read.

### GeoPackage map context (2026-10-15)

The Portugal small-scale map exposed three limitations: country boundaries
cannot be triangulated as fans, QGIS label paths can be compound circular
curves, and a world-sized sea polygon cannot be projected as a whole into a
local engineering CRS.

GeoPackage parsing now runs in a dedicated worker, with processing progress.
Its database and geometry buffers stay on the device; the worker is terminated
after a load to release SQLite's peak memory. Polygon triangles and curve
segments are clipped in the source frame before reprojection, then bounded to
the requested area in the model's CRS. Holes survive the clipping. Curves are
linearised for display; QGIS label text and styling are not interpreted.

CRSs are resolved through `gpkg_spatial_ref_sys.organization` and
`organization_coordsys_id`, or its WKT definition: `srs_id` is a database key,
not an EPSG code. Without an IFC placement, a declared projected CRS is used
for a local preview, or EPSG:3857 for geographic coordinates; the existing UI
states that this preview is not aligned to the IFC. Unreadable features are
counted and reported instead of disappearing silently.

### Context feature inspection (2026-10-15)

Readers retain source feature IDs, types, layers and attributes alongside compact
triangle ranges. GeoPackage reads non-geometry columns; GeoJSON keeps properties;
CityJSON keeps CityObject IDs/attributes; GML groups surfaces by owning feature
and reads non-geometry XML fields. The large GML reader tracks metadata while
streaming, including fields after geometry, without retaining distant objects.

Canvas inspection raycasts the visible IFC and context surfaces together. Context
selection highlights every surface of the feature and shows its read-only metadata
in the existing properties panel. It has independent state and never creates an
IFC entity reference or enters IDS, BCF element references, clash or federation data.
Hiding, replacing or removing context clears this selection.

### Context outlines and property colours (2026-10-16)

Context surfaces use the same edge shader as IFC models. Edge masks are computed
once in a dedicated worker, with adjacency partitioned by source feature so
coplanar parcels keep their shared boundary. The Geo panel controls their width
and visibility separately from IFC edges.

A selected metadata property groups features by typed values; the panel assigns
automatic colours and lets the user override each value through a searchable,
virtualized legend. Missing, null, zero, false and empty text remain distinct.
Selection highlighting overlays this style and restores it on deselection.
The context appearance travels in `project.json`; older projects default to
visible one-pixel edges and original colours. All processing stays local.

### GML surface triangulation (2026-10-16)

Concave urban-area boundaries and CityGML roofs exposed triangle fans drawing
outside the source polygon, overlapping adjacent surfaces. Both GML readers
now triangulate complete polygons with their interior rings. The shared helper
projects each surface onto its dominant plane, preserving vertical walls,
sloping roofs, original elevations and winding. Local coordinates keep the
projection stable with large survey coordinates.

The large-file reader tracks polygon identity and hole roles across chunks.
Clipping retains an exterior and its holes together; a courtyard is never
treated as a separate filled surface. Feature metadata and triangle ranges
remain attached to the resulting triangles. Parsing stays on the device and
large files still run in the worker without creating a full XML document.
