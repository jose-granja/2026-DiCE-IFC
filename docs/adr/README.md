# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [001](001-ifc-engine.md) | IFC engine: IFC-lite behind an adapter | Accepted |
| [002](002-signature-container-format.md) | Signature container: ASiC-E with XAdES | Accepted, pending Q4 |
| [003](003-map-tile-provider.md) | Map tiles: self-hosted Protomaps PMTiles | Accepted; **amended** — OpenFreeMap for dev, opt-in MapTiler styles, camera-following extent, Cesium globe replaces the texture basemap, Bing removed in favour of MapTiler's OSM style; **Google Maps 2D through ion replaces MapTiler** (2026-11-04) |
| [004](004-card-signing-companion.md) | Card companion: forked Web eID; CMD dropped | **Companion choice superseded by 007**; card/CMD analysis stands |
| [005](005-bcf-implementation.md) | BCF: own reader/writer, XSD-validated | Accepted |
| [006](006-canonical-xml-by-construction.md) | XMLDSig: canonical XML by construction | **Superseded by 008 — the premise was wrong** |
| [007](007-local-signing-companion.md) | Own local signing companion; localhost in the trust boundary | Accepted, supersedes 004's companion choice; **amended** — automatic pairing, installers, one PIN prompt |
| [008](008-real-canonicalization.md) | Implement exclusive XML canonicalisation | Accepted, supersedes 006 |
| [009](009-bsdd-suggestions.md) | bSDD suggestions in the IDS editor, via a same-origin proxy | Accepted |
| [010](010-vector-context-formats.md) | CityJSON, GeoJSON, CityGML/GML and GeoPackage read in the browser | Accepted |
| [011](011-embedded-ifc-signatures.md) | Embedded IFC CMS signatures alongside the existing IFCZIP flow | Accepted |
| [012](012-signature-timestamps.md) | Signature time-stamps (XAdES-B-T) through a same-origin RFC 3161 proxy | Mechanism accepted; the authority is a deployment choice (Q5) |
| [013](013-human-check.md) | A human check (Cloudflare Turnstile) in front of the site | Accepted; off unless a deployment sets the keys |
| [014](014-realistic-materials.md) | Realistic materials: Poly Haven textures chosen in the browser | Accepted; off until the user turns it on; **amended** — 360into as a second library, Poly Haven's colours from flat previews; relief and roughness maps (2026-11-06) |
| [015](015-worker-csp.md) | A CSP for the Web Workers, narrower than the page's | Accepted |

## Open questions from the build brief

| # | Question | Where it stands |
|---|---|---|
| Q1 | Can Web eID drive `pteidpkcs11` unmodified? | **Resolved — no**, and no longer on the critical path. ADR 007 builds our own companion instead; the fork remains the better long-term answer if upstreamed. |
| Q2 | Who code-signs and notarises the native host installer? | **Open, and now the only thing standing between us and a clean install.** `companion/packaging/` builds both installers and `.github/workflows/companion.yml` releases them; both are unsigned, so macOS says "unidentified developer" and SmartScreen warns. Needs an Apple Developer ID and an EV certificate — money, not code. |
| Q3 | Bulk: N PIN prompts, or one manifest signature? | **Both built, decision deferred to the user.** `/sign` offers `combined` (one signature over N files, one prompt — the default) and `per-file` (N independently verifiable containers, N prompts), and states which guarantee each gives. Measuring what pteid actually prompts still needs hardware, but no longer blocks anything. |
| Q4 | Is ASiC-E the right container? | **Open — needs a consumer.** ADR 002 recommends it and keeps the container assembler swappable. |
| Q5 | Which qualified TSA, and who pays? | **Mechanism built, authority still open.** `/api/tsa` stamps a signature (XAdES-B-T) with whatever `TSA_URL` names, and the page offers it when one is set; with none, signatures are B-B. Provider options and prices read from their pages are in ADR 012. What remains is the choice, the contract, and confirming the provider's qualified time-stamping service in the trusted list. |
| Q6 | Does `cde` need to store projects/models? | **Resolved — metadata only.** `cde` holds `Project`, `ProjectMembership` and an opt-in `SignatureAudit`. No model, geometry or georeferencing data. |

## Writing a new one

Number sequentially, state the context before the decision, and record the
data the decision rests on — a measurement, a source reading, a quoted policy.
An ADR that only asserts a conclusion cannot be revisited honestly later.
