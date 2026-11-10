# ADR 014 — Realistic materials: Poly Haven textures chosen in the browser

- **Status:** Accepted. **Its libraries are superseded by ADR 016** (2026-11-08): textures now come from a curated library this deployment hosts, and Poly Haven and 360into are no longer searched live. The matching, projection, relief and brightness decisions below stand. Off until the user turns it on, per visit. **Amended
  2026-11-06:** 360into added as a second library, and Poly Haven's colours
  measured from flat previews; then relief and roughness maps. **Amended
  2026-11-07:** textures matched to the model's brightness (see the
  amendments at the end).
- **Date:** 2026-11-06
- **Related:** AGENTS.md §1 (what may cross the wire), ADR 003 (third-party tiles, opt-in), ADR 001 (the engine adapter)

## Context

Users asked for a "realistic mode": textures on the model in place of flat
IFC colours. The texture should be found in a public library by the kind of
material, then the one whose colour is closest to the model's.

IFC carries no textures worth using, and IFC-lite's geometry has no texture
coordinates. The library has to be reachable from the browser, free to use,
and the textures free to show.

**Poly Haven**, checked on 2026-11-06:

- 869 textures, all CC0. `GET https://api.polyhaven.com/assets?t=textures`
  returns them in one 850 kB JSON. Each texture has a category path
  ("Concrete/Cast Walls & Floors/Bare Cast"), flat tags, `surface_use`
  (wall, floor, ground, paving, roof, object), `condition` (clean, weathered,
  damaged…), a real-world size in millimetres, and a thumbnail URL.
- **The catalogue has no colour.** Thumbnails (`cdn.polyhaven.com`) are
  lit spheres at any size asked.
- `GET /files/<id>` lists the maps. The 1k diffuse JPEG on
  `dl.polyhaven.org` is 0.2–0.7 MB.
- `api`, `cdn` and `dl` all send `Access-Control-Allow-Origin: *`.
- API terms (`terms-of-service` header, Poly Haven/Public-API `ToS.md`):
  - free for any use, commercial included;
  - calls must be identifiable by a unique `Referer` or user agent (2.4);
  - content shown through the live API needs a visible credit naming Poly
    Haven (2.5).

ambientCG was the alternative. It is also CC0, but is not needed while one
source covers the common building materials.

## Decision

1. **Everything is chosen in the browser.** Only Poly Haven's own data is
   requested, never anything of the model's.
   - **Model data:** the worker lists each placed element's materials in
     model order (`getSurfaceMaterials`), and the renderer reports each
     element's authored colours.
   - **Material kind:** each element's first material with a recognisable
     kind decides its family (`lib/viewer/realistic/classify.ts`). The
     match uses English and Portuguese words in the name, then the IFC4
     `Category`, and maps to Poly Haven category paths.
   - **Never textured:** glass, insulation, membranes and air layers. The IFC
     class only suggests the surface (floor, wall, roof).
   - **Thumbnail colours:** the catalogue is fetched once per page. Each
     candidate in the families asked for gets a 32 px thumbnail, averaged in
     linear light over the middle of the sphere, and the colours are kept in
     `localStorage`.
   - **Choice:** the nearest CIELAB ΔE wins (`choose.ts`). A texture for
     another kind of surface costs +12, and a damaged or rusted look +15
     (+4 if merely weathered). Aerial photographs and snow are excluded.
2. **What crosses the wire:**
   - the catalogue request;
   - thumbnails of the families' candidates (Poly Haven's own vocabulary,
     not the model's words);
   - the chosen textures by id.

   Every URL the API returns is checked against those hosts before it is
   fetched. The requests send the site's origin as `Referer`
   (`referrerPolicy: "origin"`), and only these requests do: the site
   otherwise sends none.
3. **Drawn with one texture array, not a material per texture.**
   - Batches mix elements, so every model material shares a
     `DataArrayTexture` of up to 16 layers at 1024², plus a per-vertex layer
     attribute.
   - The shader projects triplanar in model space, at each texture's real
     size (clamped 0.25–10 m).
   - It pulls the texture 60 % of the way toward the element's own colour,
     so the nearest texture still reads as the model's colour. (Since
     2026-11-07, its brightness all the way and its hue 60 %: see the last
     amendment.)
   - Selection, highlights and lens colours paint over textures, as they do
     over colours. Translucent geometry (glass) is never textured.
   - Past 16 textures, the most used are kept and the rest keep their
     colours.
4. **CSP:** `connect-src` gains `https://api.polyhaven.com`,
   `https://cdn.polyhaven.com` and `https://dl.polyhaven.org` on `/viewer`
   only. Images are decoded from `fetch` responses, so `img-src` is unchanged.
5. **Off by default, on per visit, never from a project.** The switch is in
   Display. It is not part of the display settings a project saves: opening
   someone's project folder must not contact a third party.
6. **Credit:** "Textures: Poly Haven" sits bottom-right on the view while
   textures show, and the Display panel lists each material's texture with a
   link to it. The About page credits Poly Haven too.

## Consequences

- **Network on first use:** the first time on a browser fetches the
  catalogue and roughly 40–400 thumbnails, depending on how many families the
  models use (about 380 for the Cantina test model's seven). After that, only
  newly chosen textures are fetched.
- **What Poly Haven sees:** the requests show the visitor's IP address and
  this site's origin. The thumbnails reveal which families of material were
  looked for, and the downloads which textures were chosen. This is a new row
  on `/privacy` and in AGENTS.md §1.
- **Library age:** the texture set is Poly Haven's at the time of use, so a
  model can look different months later if better matches are published.
- **Quality limits:**
  - Only the diffuse map is used, with no normal or roughness maps
    (superseded: see the second amendment).
  - Triplanar projection shows seams on curved faces.
  - Textures are 1k, resized to 1024².
- **Classifying by words** misses materials named only by code ("M-01") or
  by product. Those keep their colours, and the panel says how many matched.

## Amendment 2026-11-06: a second library (360into), and Poly Haven's colours fixed

### What was measured

- **Poly Haven's colours were wrong in v1.**
  - The sphere thumbnails v1 averaged read about 14 ΔE darker than the
    textures' own diffuse maps, median over 29 textures.
  - Poly Haven's flat previews (`cdn.polyhaven.com/asset_img/primary/<id>.png`,
    present for all 839 non-aerial textures) are about 7 ΔE off, with no bias:
    the median linear gain against the diffuse maps was 0.995.
  - The preview path is not documented by Poly Haven. The sphere stays as the
    fallback.
- **360into** (`360into.com`):
  - 1,080 seamless textures, "free for personal & commercial use", no
    attribution required.
  - An open JSON API (`/api/v1/textures`, `?category=`, CORS `*`, no key)
    with a real-world size per texture, but no colour.
  - Its thumbnails are crops of the texture itself: within 0.5 ΔE of the full
    image.
- **The comparison.** For 41 typical IFC colours across nine families, the
  nearest texture of the right family was, at the median:

  | Library | Median ΔE | Matches within ΔE 5 |
  |---|---|---|
  | Poly Haven (clean textures only) | 18.1 | 8 of 41 |
  | 360into | 3.6 | 24 of 41 |
  | Both | 3.6 | 27 of 41 |

  - 360into is far ahead on stone tiles (limestone, travertine, marble),
    facing brick, paint and plaster, ceramic tiles and precast concrete.
  - Poly Haven is ahead on roof tiles, asphalt and ground, where 360into has
    three textures or none, and it is the only one with normal and roughness
    maps.

### Decision

1. **Both libraries are asked, and the nearest colour wins** with the same
   costs (`choose.ts`).
   - Each library is a `TextureSource` (`lib/viewer/realistic/source.ts`):
     `polyhaven.ts` and `into360.ts`.
   - If one cannot be reached the other is used, and the Display panel says
     so. If neither can, the model keeps its colours.
2. **360into's categories are mapped per family** (`INTO360_CATEGORIES`), each
   with the kind of surface it suits.
   - Its categories are assigned by machine. "Concrete plates" include pavers,
     so they count as floor textures, and a floor texture on a wall costs what
     it costs for Poly Haven.
   - Damaged or weathered looks are read from the texture's own words.
3. **360into's thumbnails are 512 px (about 36 kB),** too dear to measure a
   whole family. For each colour wanted, the eight candidates whose own words
   ("beige", "anthracite"…, or a material's usual colour when none is named)
   are nearest are measured.
   - The shortlist ranks all candidates, measured or not, so a repeat search
     measures nothing new.
   - Measured colours are kept in `localStorage`
     (`dice-realistic-colours-v2`; the v1 sphere colours are dropped).
4. **Colours are measured in a Web Worker** (`lib/workers/texture-colour.worker.ts`).
   - On the main thread each fetch and decode waited for the viewer's next
     frame. A first search of a 6 MB model took 165 s in a software-rendered
     browser; in the worker it takes 14–16 s.
   - The preview URLs carry no version parameter: Poly Haven's CDN resizes
     each distinct URL from scratch (1–2 s cold, about 50 ms cached), so
     every visitor should ask for the same one.
5. **360into textures:**
   - Textures over 3 MB are skipped; a few 4096² JPEGs reach 16 MB.
   - 432 of its images are not square, but `world_size` is given square.
     The height follows the image's proportions, and the layer is resized to
     a square that the shader stretches back.
6. **CSP:** `https://360into.com` joins `connect-src` on `/viewer`. Requests to
   it send no `Referer`; its API asks only that responses be cached.
7. **Credit:** the view's credit names each library whose textures are shown
   ("Textures: Poly Haven · 360into"). Each line in Display links to the
   texture's page in its own library.

### Consequences

- **What 360into sees:** a new third party, on `/privacy` and in AGENTS.md §1.
  - The visitor's IP address.
  - The categories asked for (360into's own vocabulary).
  - The thumbnails and textures fetched.
  - Nothing of the model, and no `Referer`.
- **Licence provenance is less certain than Poly Haven's CC0.**
  - 360into says imported textures "keep their original open licence", but the
    API gives no per-texture source or licence.
  - Some names are manufacturers' product names.
  - The site is new: every texture is dated September 2026. A deployment that
    needs certainty should treat this as an open question.
- **360into's world sizes can be odd:** 189 textures report 6 m and 102 the
  site default of 2 m. Sizes are clamped to 0.25–10 m as before.
- **On a real model** (`3D.ifc`, 588 textured elements), 11 of 14 textures
  came from 360into:
  - its paint on rendered walls;
  - its stone tiles for "Pierre Taza" and granite;
  - Poly Haven's for timber, block and soil.
  - About 13 MB was fetched on a first search.

## Amendment 2026-11-06 (2): relief and roughness

### Decision

1. **Every texture draws with relief, roughness and occlusion,** packed into a
   second texture array beside the colour one (`relief.ts`): normal x and y
   (OpenGL convention), roughness and occlusion in one RGBA layer per texture.
   - At 512², half the colour's side: 2–4 mm a pixel over a tile of a metre or
     two, for a quarter of the memory. At 16 layers the two arrays hold 80 MB
     before mipmaps.
   - The data is linear and decoded without a colour profile.
2. **Poly Haven:** its own `nor_gl` and `arm` (occlusion, roughness,
   metalness) 1k JPEGs, listed by `GET /files/<id>` beside the diffuse map.
   Metalness is not used: the materials it would matter for are few, and
   there is no channel left for it.
3. **360into publishes a photograph only,** so its relief is estimated from
   it.
   - Brightness is taken as height (darker is deeper: joints, grout, gaps
     between boards), blurred 3×3 against JPEG noise, and its slope, wrapping
     round the tile, gives the normal.
   - The roughness is the family's usual one (`FAMILY_ROUGHNESS`: glazed tiles
     0.35, concrete 0.85…), a little rougher in the dark parts.
   - No occlusion: a photograph already has its shadows.
4. **A relief map that cannot be loaded falls back to the estimate.** It costs
   the relief, never the texture.
5. **In the shader,** each projection's normal sample leans the face's normal
   along the directions the image's right and top run on the face. Flat
   shading's normal faces the camera, so relief stands out of whichever side
   is seen. Roughness replaces the material's 0.9. Occlusion dims only the
   light from all round (ambient and sky), not the sun's.
6. The Display panel says, per line, whether the relief is the library's or
   estimated (a tooltip, and `data-relief`).

### Consequences

- **More downloaded:** about 1.2 MB more per Poly Haven texture (the normal
  and `arm` maps). Nothing more for 360into.
- **Estimated relief is a guess.** It reads well where dark means deep
  (brick, tiles, stone, rendered walls) and can raise a dark stain or a
  painted pattern into a bump.
- **On `3D.ifc`:** 14 textures, 5 with Poly Haven's maps and 9 estimated, no
  shader errors and no CSP violations.
- **What the libraries see is unchanged** apart from the two extra map
  downloads per chosen Poly Haven texture, which name the same texture.

## Amendment 2026-11-07: textures as light as the model

Textured elements drew darker than the plain ones they replaced. On `3D.ifc`
the textured pixels averaged 16 % darker than with realistic materials off,
and a terracotta deck read nearly black.

Two causes, both in how the texture was pulled toward the element's colour:

- The target was the IFC colour decoded from sRGB (`pow 2.2`). But the plain
  material draws the IFC value as it is, as linear, so the target was a far
  darker colour than the one on screen: 0.7 became 0.45.
- Only 60 % of the way, so a photograph's own darkness (most read about 0.2
  linear, much darker than a model's light greys) stayed in.

### Decision

- The target is the colour the plain material draws: the vertex colour after
  IFC Lite's finish, undecoded.
- Brightness (luminance) is matched in full; only the hue keeps the 60 % pull.
  The light rig and the tone curve are set for the model's colours, and a
  photograph's own brightness is mostly how it happened to be lit.
- `choose.ts` still reads the IFC colours as sRGB to pick the nearest texture:
  that is about which texture looks like the colour, not how bright to draw it.

### Consequences

- On `3D.ifc` the textured pixels now average within 2 % of the plain model.
- A black or near-black element (the model has some) draws a black texture.
  That is its authored colour; the texture's pattern still shows faintly.
