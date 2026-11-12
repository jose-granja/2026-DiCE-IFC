# ADR 017 — IFC property names in Portuguese, from bSDD, as a label

- **Status:** Accepted, built (2026-11-11; revised 2026-11-12: read live from bSDD)
- **Date:** 2026-11-11
- **Related:** ADR 009 (bSDD suggestions), ADR 016 (the backend), AGENTS.md §1 (what may cross the wire), §9a

## Context

The properties panel shows IFC's own names: `FireRating`, `LoadBearing`,
`ThermalTransmittance`. A Portuguese user reads them as English.

The buildingSMART Data Dictionary (bSDD) has the IFC 4.3 dictionary in about
twenty languages, Portuguese from Portugal (`pt-PT`) among them. On
2026-11-11 it named 998 of the dictionary's 2 501 properties in pt-PT. For
the common element classes that is about 90% of their properties (`IfcWall`
210 of 233), but only half of `IfcSpace`'s. Where it has no translation it
answers in English. Each property is defined once for the whole dictionary
(`.../ifc/4.3/prop/FireRating`), and a class's view of it carries the same
name, so a property's code is enough to look its name up. That was checked
against every property of four classes. `/api/Dictionary/v1/Properties`
lists the dictionary a thousand properties at a time: three requests per
language.

bSDD's translations are its own, and not all are good: `LoadBearing` is
"Capacidade de Carga" (load capacity, not load-bearing).

## Decision

**A label, not a rename.** The IFC name stays the property's name everywhere:
IDS, filters, quantities, lenses and exports match on it. The panel shows the
Portuguese name under it, smaller and muted (`PropertyTable`'s `translation`),
with `lang="pt-PT"`, and the panel's filter finds a property by its label
too. In English nothing is added: bSDD's English names are the IFC ones with
spaces.

**Only buildingSMART's own sets.** A property is labelled only in a set whose
name starts with `Pset_` or `Qto_`, which IFC reserves for them. A company's
`Status` in `Acme_Wall` may mean something else.

**Read live from bSDD, through this app's server.** bSDD sends no CORS
headers, so the browser cannot ask it. `app/api/bsdd/property-names/route.ts`
(`lib/bsdd/dictionary-names.ts`) reads the dictionary's listing in English and
in pt-PT, three pages each (about 1.5 s), and answers with only the names that
differ from the English and from the code: 997 in pt-PT, 44 KB. A listing that
comes back short is an error, not a partial table. The table is built at most
once a day per server process and concurrent asks share one build. When a
rebuild fails the previous table is served and bSDD asked again ten minutes
later; with no previous table nothing is kept, so the next ask tries again. The viewer asks
`/api/bsdd/property-names?language=pt-PT` once per page, in Portuguese only.
With bSDD unreachable there are no labels, and nothing else changes.

This replaces the first version of this decision (same day), where the backend
kept the table, an admin refreshed it from bSDD, and the app shipped a copy.
That kept a second copy to maintain and an admin step for every bSDD release.
The backend's `dictionary` app (table, overrides, **Update from bSDD**,
`refresh_property_names`) is left in place for now, unused by the viewer.

**Not per element.** Asking bSDD for the selected element's class would send
class names from the viewer and add a delay to every selection. The
dictionary-wide listing sends only the dictionary's URI and the language.

## Consequences

- No new origin and no CSP change: the viewer's request is same-origin and
  carries a language code, nothing from a model. The server's requests to bSDD
  carry the dictionary's URI and the language; bSDD sees the deployment's
  address, not the user's.
- Labels depend on bSDD having been up once since the server started. bSDD
  was down for over 40 minutes on 2026-11-10; a server started during such an
  outage shows the IFC names alone until bSDD answers.
- bSDD's own translations are shown as they are, including the poor ones
  (`LoadBearing`). The backend's overrides are not applied.
- A property in a model built to IFC2x3 or IFC4 is labelled with its IFC 4.3
  name. The standard names barely changed between them, and a property IFC
  4.3 dropped is just not labelled.
- Property set names (`Pset_WallCommon`), descriptions and enumeration values
  are not labelled. bSDD translates descriptions only in part.
