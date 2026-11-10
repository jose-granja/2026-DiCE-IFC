# ADR 016 — Textures: the model's own first, then a library we host

- **Status:** Accepted, built (2026-11-08). Supersedes ADR 014's choice of
  libraries (Poly Haven and 360into, searched live); ADR 014's matching,
  projection and relief stand.
- **Date:** 2026-11-08
- **Related:** ADR 014 (realistic materials), AGENTS.md §1 (what may cross the wire), §8c-quater

## Context

Realistic materials (ADR 014) searched two online libraries, Poly Haven and
360into, every time it was switched on. It worked, but:

- **Every visit left for two third parties.** That is why the feature was
  opt-in and per visit, with its own privacy text and CSP entries.
- **Results drifted.** A library adds, renames or removes a texture, or is down,
  and the same model looked different.
- **Quality varied.** The nearest texture by name and colour was used,
  whatever its scale or seams. 360into's photographs have no relief maps, so
  their relief was estimated and could turn a stain into a bump.
- **It was slow the first time.** Candidates' colours were measured from
  previews before anything was chosen.
- **It ignored the model's own textures.** IFC can carry them
  (`IfcSurfaceStyleWithTextures`), and some Revit and Archicad exports do.
  The engine already read them (`@ifc-lite/geometry` 7.9: per-vertex `uvs`, a
  decoded `texture` for `IfcBlobTexture`/`IfcPixelTexture`, a `textureRef` for
  `IfcImageTexture`); the adapter dropped all three.

Larger online libraries don't fix this. ambientCG, the largest CC0 one (2040
materials), was checked on 2026-11-08: its API sends no CORS header, its
downloads are ZIPs of about 10 MB at 1K, and the separate maps a browser can
fetch are 2048 px, about 8 MB per texture. A good source to build from, not to
search live.

## Decision

Per element: **the model's own texture**, then **a texture from a library this
deployment hosts**, then **the element's colour**.

The user's decisions on the open questions of the proposal:

1. The online libraries are removed once the hosted library works. Done: the
   Poly Haven and 360into clients, the colour-measuring worker and its cache,
   and their CSP entries are gone.
2. The library lives in this app, served by **a Django Ninja backend**
   (`backend/`). This is the first backend since accounts were removed; it
   holds nothing a user made and is read-only for visitors.
3. 1K everywhere, and 2K for walls and floors.
4. The switch is remembered across visits and saved in projects. Amended
   2026-11-10 at the user's request: no longer remembered, so the viewer opens
   without textures; still saved in projects.

### Part A — the model's own textures

- `MeshView` gains `uvs` and `texture` (key, repeat, embedded `pixels` or an
  image `url`). Meshes sharing an image share one copy, transferred from the
  worker once.
- `IfcImageTexture` is read only from what the user opened: `container.ts`
  keeps a `.ifczip`'s images by lower-case file name, and a reference is
  matched by the file name it ends in, whatever its path. **A network URL is
  never fetched** (it comes from the model's contents, §1); the element keeps
  its colour and the viewer says why, as it does for an image the archive does
  not have.
- Batches split by texture, one material with a `map` each. The map is drawn
  through `aSurfaceLayer` = −1, so a lens, highlight or selection paints over it
  as over a realistic texture. Its pixels are taken raw, as the model's colours
  are, so a texture is as light as a colour of the same value.
- Always shown, like the authored colours; realistic materials leaves any
  element with an own texture alone.

### Part B — the hosted library

- **Curated, in git:** `backend/textures/selection.json`, 149 textures over the
  16 families, from Poly Haven and ambientCG, CC0 only. Proposed by
  `propose_texture_selection` (a spread over each family's colours, damaged and
  odd textures filtered out), to be reviewed on `/texture-library/review/`.
- **Built by a command, not in git:** `build_texture_library` downloads each
  texture once (cached), writes WebP colour, OpenGL normal and
  occlusion/roughness/metalness maps at 1024 and, for walls and floors, 2048, a
  thumbnail, and the mean colour measured exactly as the viewer measures it.
  Folders are content-addressed, so files are cached for good. ambientCG's maps
  come from its 2048 px surface previews (one file each, not a 34 MB ZIP), its
  DirectX normals flipped: checked against its own OpenGL normal for
  Bricks076C, the flipped green channel differs by 1.1 levels on average, the
  unflipped by 54.
- **Served from this origin:** Django Ninja answers
  `/texture-library/api/manifest` (and `/textures/{id}`, `/health`); nginx
  serves `/texture-library/files/` from a shared volume; `next dev` and
  `next start` forward `/texture-library/` to `TEXTURE_LIBRARY_ORIGIN`. The CSPs
  lose the four library origins: a worker's `connect-src` is `'self'` again.
- **In the browser:** `library.ts` reads the manifest once, schema-checked (a
  file path must be a plain relative path under this origin); `apply.ts`
  chooses from its colours and loads only the chosen textures.
- **One texture per material** (amended 2026-11-09, at the user's request).
  The choice was per (family, kind of surface, colour), so one material with
  two colours, or on a wall and a slab, could draw two textures. Now each
  material (its name, within its family) asks once, with the colour and the
  kind of surface most of its elements have. Each element still pulls the
  texture toward its own colour in the shader.
- **2K only when it fits:** every layer of the texture array is one size, and a
  2K layer costs four times a 1K one, so layers are 2K when 8 or fewer textures
  are needed, and all 1K otherwise.

## Consequences

- **The library is about 370 MB** (149 textures; about 2.5 MB each with their
  2K maps) and its build downloads about 1 GB, once. A deployment that has not
  built it gets "This server has no texture library installed" and the model's
  own colours.
- **Nothing leaves for a third party any more** for textures; the server sees
  which textures were asked for, as for any file it serves.
- **Narrower than a live search:** 149 textures against about 3000, every one
  chosen on purpose. Adding one is a line in `selection.json` and a build.
- **A model with more than 8 textures draws them at 1K**, as before.
- **A second service to run**: `backend` in `docker-compose.yml`, with a
  `DJANGO_SECRET_KEY`. The admin and review page are off unless
  `TEXTURE_LIBRARY_ADMIN` is set.
- **AGENTS.md §1 changed**: it said there was no backend and that any server
  work should be a Next.js route handler. The texture library is the one
  exception, by the user's decision, and holds no user content.
