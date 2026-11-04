# ADR 003 — Map tile provider

- **Status:** Accepted; **amended 2026-09-05** (OpenFreeMap for development), **2026-09-08** (MapTiler styles; camera-following extent; Cesium ion 3D tiles), **2026-09-18** (Bing removed from the Cesium globe; MapTiler's OpenStreetMap style used instead) and **2026-11-04** (Google Maps 2D through Cesium ion replaces MapTiler). See the amendments.
- **Date:** 2026-09-03
- **Phase:** decided in Phase 1, used in Phase 4

## Context

`/georef` places a model footprint on a world map with MapLibre GL JS. That
needs a basemap, and a basemap needs tiles from somewhere.

This is the only part of the app that wants to talk to a third party at all, so
the choice is a privacy decision as much as a technical one: **tile requests
reveal where the user is looking.** A sequence of tile requests around a
specific coordinate at a specific zoom is, in practice, "this firm is working on
a building here" — which is exactly the kind of thing a practice may be under
NDA about, and exactly the kind of inference the rest of this app is built to
prevent.

The OSM public tile server is not an option regardless: its usage policy forbids
production application use.

## Decision

**Protomaps with self-hosted PMTiles, as the default and the documented
recommendation. MapTiler with an API key as a configurable alternative.**

- A PMTiles archive is a single file served over HTTP range requests. Host it on
  the app's own origin and the map becomes **same-origin** — no third party in
  `connect-src`, no tile requests leaving the deployment, and the CSP in
  `frontend/next.config.ts` and `nginx/nginx.conf` needs no third-party entry
  at all. That is why the shipped CSP has none.
- A Portugal extract is small enough to ship with the deployment, which also
  makes `/georef` work on a disconnected site network.
- `NEXT_PUBLIC_TILE_ORIGIN` selects a different provider. When it is set, that
  origin is added to `connect-src` — one place, deliberately visible.

## Consequences

- **The default deployment adds no third-party origin to the CSP.** Any change
  to that is a change to this ADR, not a config tweak.
- Someone has to generate and host the PMTiles extract, and refresh it
  occasionally. Document that in the deployment guide alongside the nginx setup;
  a stale basemap is a cosmetic problem, not a correctness one, so the refresh
  cadence can be slow.
- Choosing MapTiler means accepting that the tile provider learns the rough
  location of every model a user georeferences. If a deployment does that, the
  `/privacy` page must say so — the table there already has a row for tiles, and
  it must stay accurate for whichever provider is configured.
- 3D context (MapLibre terrain, and optional OGC 3D Tiles via deck.gl's
  `Tile3DLayer`) has the same property: whatever origin serves it goes in the
  CSP and on the `/privacy` page, or it does not ship.


---

## Amendment, 2026-09-05 — OpenFreeMap in development

The default above is unchanged: **a deployment that sets no tile origin still
reaches no third party.** What changed is that the development environment now
sets one, deliberately and with this ADR updated, which is what the original
text asked for.

`.env.dev` had pointed `NEXT_PUBLIC_MAP_STYLE_URL` at
`https://tiles.openfreemap.org/planet` without setting
`NEXT_PUBLIC_TILE_ORIGIN`. That was wrong twice over:

1. **The CSP blocked it**, which is the system working. MapLibre surfaced it as
   `AJAXError: Failed to fetch (0)` — a message that says nothing about the
   cause. `GeorefMap` now checks whether the style's origin is one the CSP
   permits and, if not, falls back to the tile-less map and says so on screen.
2. **`/planet` is not a style.** It is a TileJSON source document. MapLibre's
   `style` option needs a style with `version: 8`, `sources` and `layers`, which
   is what `/styles/liberty`, `/styles/bright` and `/styles/positron` return.
   The URL would have failed even with the CSP open.

### What was chosen

`https://tiles.openfreemap.org/styles/liberty`, with
`NEXT_PUBLIC_TILE_ORIGIN=https://tiles.openfreemap.org`.

Everything the style needs — vector tiles, glyphs and the sprite — is on that
one origin, so one CSP entry covers it.

The tile origin was also added to `img-src`, on the assumption that the sprite
loads as an ordinary image. **That assumption was wrong**, and checking it took
one run: reverting the `img-src` line leaves the basemap loading unchanged,
because MapLibre fetches the sprite with `fetch` like everything else — it needs
the pixels to build a texture atlas. The line is kept for *raster* styles, which
do load tiles as images, and the comment now says that instead. Verified by
counting requests: 1 style, 13 vector tiles, 2 sprite, no CSP violations.

OpenFreeMap needs no API key and states that it does not log requests, which
makes it a materially better third party than the alternatives — but it is still
a third party, and the consequence the original ADR names holds:

> Choosing [a third-party provider] means accepting that the tile provider
> learns the rough location of every model a user georeferences.

The `/privacy` page names OpenFreeMap accordingly. A deployment that cannot
accept that should unset `NEXT_PUBLIC_MAP_STYLE_URL` — the module's footprint,
CRS grading, control-point fit and residuals all work without a basemap — or
self-host PMTiles as the default recommends.


## Amendment — 2026-09-08: a choice of basemap, and no edge to it

### Satellite imagery, which a vector style cannot substitute for

The module answers "is this building in the right place". Against a drawn street
map that is a question about geometry lining up with lines. Against **imagery**
it is a question about the building sitting on the right plot, which is the one
people actually want answered — and no vector basemap can answer it.

`NEXT_PUBLIC_MAPTILER_KEY` therefore adds three MapTiler styles: Streets,
OpenStreetMap and Satellite. The trade-offs are unchanged from the original
decision and are simply accepted per deployment rather than globally:

- **Off unless a key is set.** With no key, `api.maptiler.com` is absent from
  the CSP *and* the styles are absent from the menu — both driven by the same
  variable, so they cannot drift into a menu entry that the CSP then blocks.
- **The deployment's own basemap stays first** and stays the default. A
  self-hosted Protomaps style reaches no third party at all, and that remains
  the recommendation; MapTiler is a choice a user makes per session.
- **The privacy cost is the one this ADR already described**: a tile request
  says roughly where the user is looking, which here is where the building is.
  MapTiler additionally ties those requests to an account key. `/privacy` says
  so.

Satellite is a **raster** style, so its tiles are images rather than geometry.
That is the one case where `img-src` genuinely matters and not just
`connect-src` — the opposite of the vector-style finding recorded in
`proxy.ts`, where an `img-src` claim turned out to be speculative.

MapTiler's style IDs (`streets-v2`, `openstreetmap`, `satellite`) are taken from
its published catalogue and are **not verified here**: every request without a
valid key returns 403, including for a style that does not exist, so a keyless
probe cannot distinguish a real ID from a typo.

### The basemap no longer has an edge

The texture used to cover a fixed square, sized from the model's own extent
(`extentForModel`, now removed). That is a rug, not a map: zoom out and its
border is on screen with empty space beyond it, which looks like the data
stopping rather than the picture stopping.

It now covers whatever ground the camera is looking at —
`renderer.getGroundView()` from the orbit distance and field of view — and
re-renders when the camera settles. Measured on the wall fixture, pulling back
takes the covered extent from 200 m to 705 m to 15 km to 332 km with no visible
boundary at any point.

Three details that make it usable rather than a re-render storm:

- **Debounced on `change` *and* `end`.** OrbitControls emits `end` on
  pointer-up, which covers drag and pinch but not wheel zoom — that fires
  `change` with no `end` at all, so watching `end` alone never reacts to a
  scroll.
- **The extent is quantised** onto a √2 ladder for the query key, so a
  two-metre pan reuses the cached texture instead of rendering a new map.
- **The previous texture stays on the ground while the next renders**
  (`placeholderData`), so panning does not flash an empty plane.

The width is estimated from orbit distance rather than by intersecting the
frustum with the ground plane, because near the horizon two frustum rays never
meet the plane and the exact answer is "infinite", which is not a texture size.


## Amendment — 2026-09-08 (later): 3D tiles, and why the texture had to stop being the only option

Three complaints, one root cause between them: **a basemap rendered as a single
texture is the wrong shape for this job.**

- *"The zoom is not smooth."* Every camera movement re-rendered a MapLibre
  instance offscreen and swapped the result in. That is a pause and a visible
  swap, however well it is debounced.
- *"The map loses the location of the model after I zoom in and out."* A real
  bug, and mine. The new texture takes a moment, so the previous one stays on
  screen — and it was being placed at the **live camera target**. An old picture
  at a new position is a map that slides out of register with the model. The
  texture now carries the render-space position it was rendered for
  (`BasemapTexture.ground`) and placement uses that, so extent and centre can
  only ever change together. `e2e/georef-basemap.spec.ts` asserts no centre is
  ever drawn at two different extents.
- *"Show the 3D tiles in 3D."* A picture on the floor cannot answer a question
  about height.

### 3D tiles, from Cesium ion

`NEXT_PUBLIC_CESIUM_ION_TOKEN` adds a **3D buildings (Cesium ion)** option,
drawn by `3d-tiles-renderer` into the same three.js scene. It defaults to
**Cesium OSM Buildings** (asset 96188): worldwide 3D building geometry, free on
ion's free tier, needing only an account token.

Google's Photorealistic 3D Tiles were built first and then dropped. They are
better imagery, and they are billed per request against a Maps Platform key —
which is not a commitment to put behind a checkbox in a georeferencing panel.
Both are reachable through the same renderer and the same code path, so this is
a configuration choice: `NEXT_PUBLIC_CESIUM_ION_ASSET_ID` points at any ion
asset the account can see, including a practice's own city model or survey. This is not a variation on
the basemap, it is a different code path (`lib/viewer/tiles3d.ts`), and it fixes
the first two complaints structurally rather than by tuning:

- **Nothing re-renders on camera movement.** The tile set streams what the
  camera needs by itself, so zoom costs what any 3D scene costs.
- **Nothing can drift.** Each tile sits at its true position on the ellipsoid.

**Placing an earth-centred dataset in a local scene.** The tiles arrive in ECEF —
metres from the centre of the earth. The transform is applied to the tile
*group*, not to the camera: `ECEF → invert(east-north-up frame at the model) →
rotate −90° about X → render frame`. Moving the camera out to ECEF instead would
put every model vertex six million metres from the origin, and float32 makes
that visibly shake.

**The tile set is anchored to the model, not the camera.** Keying it on the
camera position rebuilds it on every zoom and throws away everything already
streamed — reintroducing exactly the stutter it was chosen to remove. This was
wrong in the first implementation and is now pinned by a test that counts
`root.json` fetches across a camera movement.

**A rejected token fails silently.** `TilesRenderer`'s `load-error` does not
fire for it; the auth plugin handles that internally, leaving a 3D map that
never appears. The panel therefore asks ion for the asset endpoint itself and
turns a 401/403/404 into a sentence naming the variable and the asset. This is
the same failure shape as the MapLibre worker bug — a silent nothing — and it is
worth treating silence as the bug rather than the symptom.

**Two origins, not one.** `api.cesium.com` exchanges the token for an asset
endpoint, and that endpoint streams from `assets.ion.cesium.com`. Allowing only
the first in the CSP gives a tileset that authenticates and then loads nothing.

**Attribution is required**, not decorative: ion's terms say the data
attribution is visible wherever the tiles are, and it changes with the tiles in
view, so it is read from the renderer rather than hard-coded.

### What is not verified

The tiles have only been exercised with a **deliberately invalid token**: the
option appears, the request goes to `api.cesium.com/v1/assets/96188/endpoint`,
the CSP allows it, the flat basemap is torn down, the tile set survives camera
movement, and the failure is reported with the variable to fix. Whether the
buildings actually draw, and how they perform, needs a real ion token and has
not been tested.

**The renderer is imported on demand** (`await import("3d-tiles-renderer/three")`
inside `createIonTiles`), so it stays out of the viewer bundle for every
deployment that does not configure a token.


## Amendment — 2026-09-18: Bing removed from the Cesium globe; MapTiler's OpenStreetMap style instead

**This ADR's own architecture has moved on from what most of the text above
describes.** The MapLibre-rendered texture (`lib/viewer/basemap.ts`,
`extentForModel`, the debounced re-render, the 3D tiles bolted on with
`3d-tiles-renderer` into the three.js scene) no longer exists in the
codebase. `lib/viewer/globe.ts` replaced the whole approach with a real
Cesium globe — terrain, imagery and 3D tiles all as Cesium layers, the
camera synced to it every frame rather than a texture re-rendered on
settle. That rewrite is real and is this ADR's current implementation; the
sections above describing the texture era are kept as history, not
instructions.

### What prompted this amendment

Activating "3D world context" with the default "Terrain and imagery" layer
threw a CSP violation: `Cesium.ImageryLayer.fromWorldImagery({})` — Cesium's
shorthand for Bing Maps Aerial — fetches straight from
`dev.virtualearth.net`, an origin this CSP had never allowed and this ADR had
never decided on. It was added implicitly, by calling a Cesium convenience
function without reading what it does. Removed outright: the "terrain" layer
is now terrain-shaded geometry only when nothing else is configured, no new
origin, no ADR needed for the removal.

### The obvious next thought, and why it doesn't survive contact with this ADR

The natural replacement — match
[bedrock-engineer/ifc-georeferencer](https://github.com/bedrock-engineer/ifc-georeferencer),
which draws OpenStreetMap tiles straight from `tile.openstreetmap.org`, no
key required — runs straight into this ADR's own original context:

> The OSM public tile server is not an option regardless: its usage policy
> forbids production application use.

That line was written 2026-09-03, before any of the MapTiler or Cesium work
existed, and it still holds. Reusing OSM's shared tile server is a policy
reversal, not a config change, and would need its own ADR amendment arguing
why production use is now acceptable — not a quiet swap for the one Bing
was filling.

### What was chosen instead

MapTiler's `openstreetmap` raster style, fetched as a
`Cesium.UrlTemplateImageryProvider` and added as a `Cesium.ImageryLayer` when
the globe is created:

```
https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.png?key=<NEXT_PUBLIC_MAPTILER_KEY>
```

- **No new CSP origin.** `api.maptiler.com` has been a conditional
  `connect-src`/`img-src` entry since the 2026-09-08 amendment, for exactly
  this variable. This is the first code that actually uses it — checking
  found no other reference to `NEXT_PUBLIC_MAPTILER_KEY` anywhere outside
  `proxy.ts`, i.e. the "three MapTiler styles" that amendment described were
  never wired into the (now-removed) texture basemap either. This amendment
  is that feature's first real implementation, on the code path that exists
  today.
- **Same opt-in shape as everything else in this module.** No key: the
  origin is absent from the CSP, the layer is skipped, "Terrain and imagery"
  reads as plain "Terrain" in the menu (`GlobeControls.tsx`), same as before
  this amendment. A key: the label changes to say so, and the attribution
  line adds "© MapTiler © OpenStreetMap contributors" — MapTiler's terms
  require the credit wherever its tiles are shown, same requirement ion and
  Google already have in this module.
- **Production-appropriate by design.** Unlike the public OSM server,
  MapTiler's raster tile API is built to be called from a real deployment,
  which is the entire objection to the alternative above.

Not verified: whether the tiles actually draw well under the model — needs a
real MapTiler key, which development does not currently have configured.
Same caveat this ADR already carries for the ion 3D tiles amendment above.

## Amendment — 2026-11-04: Google Maps 2D through Cesium ion replaces MapTiler

### Context

The 2026-09-18 amendment put MapTiler's OpenStreetMap raster style under the
Cesium globe — the only remaining use of MapTiler (the MapLibre basemap and
its styles had gone). It meant a second account, a second key and a second CSP
origin for one picture, while terrain, OSM Buildings, Google Photorealistic and
custom tilesets all came from one ion token.

Cesium ion now carries Google's 2D maps as ordinary imagery assets. Read with
this deployment's token from `GET /v1/assets/{id}` and `/endpoint` on
2026-11-04:

| Asset | Name | Endpoint |
|---|---|---|
| 3830182 | Google Maps 2D Satellite | `externalType: GOOGLE_2D_MAPS`, `url: https://assets.ion.cesium.com/proxy/3830182` |
| 3830183 | Google Maps 2D Satellite with Labels | same shape |
| 3830184 | Google Maps 2D Roadmap | same shape |
| 3830185 / 3830186 | Labels Only / Contour | not used |

The endpoint answers with a Google session and key, and a **proxy URL on
`assets.ion.cesium.com`**: the browser asks ion for the tiles, not Google. Its
attributions are ion's logo, "Upgrade for commercial use" (the account's plan)
and Google's logo (`assets.ion.cesium.com/google-credit.png`).

### Decision

- **The map under the terrain is Google Maps 2D, through ion**
  (`Cesium.Google2DImageryProvider.fromIonAssetId`), chosen in the GIS panel:
  road map (default — closest to the OSM map it replaces), satellite,
  satellite with labels, or none. Saved in projects; a project from before
  reads as road map.
- **MapTiler is removed**: `NEXT_PUBLIC_MAPTILER_KEY`, `api.maptiler.com` in
  the CSP, its credit on `/about`, its label in the menu.
- **No new CSP origin.** The tiles come through `assets.ion.cesium.com`,
  already present whenever a token is; the Google logo is on the same host.
- **Hidden under Google Photorealistic 3D**, which covers the ground itself —
  drawing a map nobody can see would only spend requests.
- **Attribution**: "© Cesium ion", Google's logo **on the map** (bottom-left;
  ion serves a white logo, made for imagery), and the data credit Google's
  viewport endpoint returns for **the area in view** ("Map data ©2026 Google",
  "Imagery ©2026 …"). Cesium's provider asks that endpoint for the whole
  planet, which over satellite names every supplier in the world; the globe
  asks for the camera's own rectangle instead. Google's Map Tiles policies
  want the logo and the credit with the tiles.

### Consequences

- One account, one token. Without a token — or with its quota spent — there is
  neither terrain nor a map; with MapTiler, a map could be drawn alone.
- The look changes from OpenStreetMap cartography to Google's.
- **Licensing is the operator's to check**: the attribution ion returns on this
  account says "Upgrade for commercial use", i.e. the plan in use is for
  non-commercial use. Google's tiles also count against ion's usage.
- Google learns nothing new directly — the requests go to ion — but the
  privacy statement now names Google as the map's source (`/privacy`).

Verified in the app, against the real assets: see `e2e/globe-imagery.spec.ts`.
