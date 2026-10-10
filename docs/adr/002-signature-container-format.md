# ADR 002 — Signature container format

- **Status:** Accepted, pending confirmation from a consumer (Q4)
- **Date:** 2026-09-03
- **Phase:** decided in Phase 1, implemented in Phase 3
- **Related:** ADR 004 (card companion)

## Context

Modules 2 and 7 must produce a signed IFC and a signed BCF that a third party
can verify. Neither native container has a signature slot:

- `.ifczip` is a plain ZIP holding one `.ifc`.
- `.bcfzip` is already a ZIP (`bcf.version`, `project.bcfp`, `{topic-guid}/…`).

So the signature has to go somewhere, and the choice is between inventing a
convention and using a standard one.

## Decision

**ASiC-E (ETSI EN 319 162) with XAdES in `META-INF/signatures001.xml`.**

```
model.ifczip                    issue-set.bcfzip
├── model.ifc                   ├── bcf.version, project.bcfp, extensions.xml
├── META-INF/                   ├── {topic-guid}/…
│   ├── manifest.xml            └── META-INF/
│   └── signatures001.xml           └── signatures001.xml
```

Both remain valid ifcZIP / bcfzip archives: a tool that knows nothing about
signatures sees the payload it expects and ignores `META-INF/`. A
signature-aware tool reads `META-INF/`. Nothing is invented.

### Consequences that shape the implementation

1. **Hash the bytes exactly as read. Never re-serialise before signing.**
   A STEP round-trip reorders instances and rewrites the header, so a model
   exported and then signed produces a signature that does not verify against
   the file the user thinks they signed. The georeferencing module's
   write-back therefore produces a *new* file which is then signed as-is —
   export and sign are two steps, in that order, never fused.

2. **Parallel signatures are a first-class case, not an afterthought.**
   ASiC-E allows `signatures002.xml`, `signatures003.xml`, … so author →
   reviewer → coordinator co-signing is natively supported. Build it in from
   the start: it is the feature no BIM tool currently offers, and retrofitting
   it later means rewriting the container assembler.

3. **Two bulk shapes, both legal, one default.**
   - *Per-file* — N signatures, N PIN prompts, N independently verifiable
     containers.
   - *Manifest* — one XAdES signature over an `ASiCManifest`-style list of
     digests, one PIN prompt, shipped as one multi-payload ASiC-E.

   Default to the manifest form for a coherent model set; offer per-file as an
   explicit alternative. **The UI must state which guarantee the user is
   getting** — under the manifest form an individual file pulled out of the set
   is no longer independently verifiable, and that is a real difference, not a
   detail. The default flips on the measurement in ADR 004's "Still open".

4. **Profile ladder: XAdES-B → XAdES-T → XAdES-LTA.**
   B is the floor and needs nothing but the card. T needs a qualified TSA
   (Q5, unresolved — check whether UMinho already has one before buying).
   LTA is not optional in the long run: Cartão de Cidadão signing certificates
   are short-lived relative to the life of a building model, so a signature that
   is only B or T becomes unverifiable long before the building is finished.

   **Design the builder so B → T → LTA is a later pass over an existing
   container, not a rewrite.** Upgrading must be able to open a signed
   `.ifczip`, add unsigned properties to `signatures001.xml`, and re-zip.

5. **Verification is offline except for revocation.** Drop a container in, re-hash
   the payload, verify the XAdES against the embedded certificate, check the
   chain against the Portuguese trusted list, report timestamp and revocation
   status. Bundle a TSL snapshot as a fallback and **warn when it is stale** — a
   silently outdated trust list turns "cannot check" into "looks fine".

## Alternatives considered

**A detached `.p7s` / `.xml` sidecar next to the container.** Simpler to
produce, and no ZIP surgery. Rejected: two files travel together badly. Email,
a CDE upload or a USB stick separates them, and a signature nobody can find is
worse than no signature. ASiC-E keeps them in one artefact that existing tools
still open.

**CAdES/CMS instead of XAdES.** Rejected for a practical reason from ADR 004:
ECDSA signature values come back from PKCS#11 as raw P1363 `r‖s`, which is
exactly what XMLDSig/XAdES wants. CMS would need DER re-encoding of every
ECDSA signature — an extra step that only exists to serve a format we have no
other reason to prefer. ASiC-E supports both; XAdES is the cheaper half.

## Still open — Q4

**Does whoever consumes these files accept ASiC-E?** ASiC-E is the correct
answer standards-wise, but "correct" and "accepted by the client's CDE" are
different properties. Confirm with an actual consumer before Phase 3 ships. If
a bare `.ifczip` with a sidecar is mandated, the container assembler is the only
thing that changes — the XAdES builder, the manifest logic and the signing
provider are all unaffected. Keep that boundary clean for exactly this reason.
