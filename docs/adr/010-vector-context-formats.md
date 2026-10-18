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

### Placement in the viewer

Context vertices are map-space metres relative to their projected origin. That
origin must pass through the inverse IFC map conversion, conversion to render
metres, subtraction of the RTC shift, and the model group's full transform.
The vertex deltas use the corresponding net rotation and scale. Applying only
the group's translation mixes model axes with map axes and shifts the context.

WFS spatial filters return complete intersecting features, so a small requested
area can produce polygons extending kilometres away. Their geometry origin is
not the query centre; placement must be independent of that choice of origin.
`context-placement.ts` owns this transform for all context formats, and updates
the loaded mesh when the reference placement changes without rebuilding buffers.

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
- GeoPackage, GML, GeoJSON and CityJSON preserve concave polygons and holes
  through polygon triangulation.
- A GeoPackage's tile pyramids and attribute-only tables are ignored; only
  `data_type = 'features'` is read.

### Horizontal area reports (2026-10-18)

The GIS panel can check every advertised WFS layer, or all layers in loaded GIS
data, against the selected Geo model's horizontal bounding footprint. The check
uses projected polygon triangles, including holes, and ignores height; partial
overlaps and boundary touches count as matches. It uses full model bounds rather
than the single-layer load radius. Point markers and line ribbons are explicitly
marked as non-area triangle ranges by the readers, including mixed geometries.

Analysis runs in a worker without changing the displayed context or applying its
visibility filters. Local checks state that only the loaded extent is available.
WFS checks make bounded GetFeature requests through the existing proxy, one layer
at a time, and retain per-layer errors, incomplete responses and unchecked layers
after cancellation. Only the public service URL, layer and map bounds leave the
device. The dated report appears in Properties with source attributes and exports
as a UTF-8 CSV, including unsuccessful layer statuses and formula-safe metadata.
Reports are transient results; project files keep the original GIS snapshots.
Clicking a match displays the exact checked layer, highlights the feature, and
frames it from above without closing the report. WFS response snapshots are
retained locally only for matching layers, so viewing results does not refetch
changed data. Loaded files retain their checked geometry and feature indices.
Layer isolation and colour filters share the renderer's original-index visibility
path; the selected category is revealed, and Show all layers clears isolation.
The layer filter travels with context appearance in saved projects.

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

### WFS/WMS context services (2026-10-17)

Context accepts WFS feature exports and WFS/WMS GetCapabilities documents,
as well as service URLs. Opening capabilities from disk only lists layers;
Read layers and Load selected layer are explicit network actions. The UI names
the provider and states that service requests disclose the chosen map bounds.
WFS produces inspectable features; WMS produces an image on a projected grid
at a chosen elevation, without inventing feature geometry or attributes.

Downloads use a same-origin `/api/ogc` GET route to support providers without
CORS. The CSP remains unchanged. This route accepts only GetCapabilities,
GetFeature, GetMap and GetLegendGraphic, bounded response sizes, bounded image dimensions and
feature counts. It accepts no files, bodies, cookies or authorization headers.
Public DNS answers are validated and pinned to the outgoing socket; private
addresses, nonstandard ports and redirects are refused. It does not store or
log responses. The only outbound parameters are the chosen public endpoint,
layer, map bounds and standard read parameters (plus provider URL keys).

CRS negotiation currently covers PT-TM06 (3763), Web Mercator (3857), WGS84
(4326) and CRS:84, with version-specific geographic axis ordering. Incomplete
WFS results prompt a smaller radius instead of silently truncating the layer.
WMS supports PNG/JPEG and a fixed 1024-pixel snapshot of the chosen area.

Projects store a `.context-features` snapshot of a WFS response or a
`.context-map` archive containing the WMS image and georeferencing. Restoring
these is offline. Provider attribution remains visible while the context is
shown and is included in the snapshot. No IFC, BCF or IDS payload is sent.

GAIURB's `opendata.gaiurb.pt` server currently sends only its leaf certificate,
omitting Sectigo Public Server Authentication CA DV R36. `ogc-tls.ts` supplies
that public intermediate for this exact hostname, preserving Node's default
trust roots (including configured extra roots on current Node versions). The
PEM comes from Sectigo's published repository and its SHA-256 is pinned in a
regression test. It introduces no new root, disables no verification, and does
not enable partial-chain trust: TLS must still reach an existing trusted root
and validate the hostname and dates. Other providers retain their default CA
selection. No certificate-discovery requests are made at runtime.

### WMS legends (2026-10-18)

Loading a WMS layer also reads its advertised PNG/JPEG legend, when present.
The first advertised/inherited style is explicitly applied to GetMap so its
legend describes the image being shown. If that style has no usable LegendURL,
an advertised GetLegendGraphic operation can generate one. Reading capabilities
or changing the layer picker alone does not fetch a legend.

`/api/ogc?legend=1` accepts only GetLegendGraphic or static `.png`, `.jpg` and
`.jpeg` paths with provider-key parameters. It shares the public DNS pinning,
TLS verification, no-redirect and no-credentials restrictions of map downloads.
Legend responses must be PNG/JPEG and at most 2 MiB; the client also caps decoded
dimensions at 4096 × 16384 and 16 megapixels. SVG, HTML, remote SLDs and arbitrary
operations are refused. This adds no CSP origin and sends no model data.

The optional legend image and title live inside the existing `.context-map`
archive; old snapshots remain readable. A collapsible GIS panel displays a local
blob URL for the loaded map, including after offline project restoration. Failure
to retrieve a legend does not prevent loading the map.
