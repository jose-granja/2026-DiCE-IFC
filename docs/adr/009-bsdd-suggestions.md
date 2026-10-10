# ADR 009 — bSDD as a suggestion source in the IDS editor

- **Status:** Accepted
- **Date:** 2026-09-06
- **Phase:** Phase 6 (IDS), added after the validator shipped

## Context

Writing an IDS means typing exact strings. `Pset_WallCommon`, `FireRating`,
`IFCWALL` — get any of them wrong by a character and the specification silently
applies to nothing, which is the worst failure mode a checker has: it reports
success. The editor already mitigates this by suggesting whatever the **loaded
model** contains, but that only helps when a model is loaded, and an IDS is
usually written *before* the model it will check.

The buildingSMART Data Dictionary is the canonical answer to "what properties
can this class carry". Probed live on 2026-09-06:

| Endpoint | What it gives |
|---|---|
| `GET /api/Dictionary/v1` | the dictionary list (IFC 4.3, national classifications, vendor sets) |
| `GET /api/Class/Search/v1?DictionaryUris=…&SearchText=…` | classes, with `referenceCode` such as `IfcWall` |
| `GET /api/Class/v1?Uri=…&IncludeClassProperties=true` | **233 properties for `IfcWall`**, each with `propertySet`, `dataType`, and for 25 of them `allowedValues` — `Status` → `DEMOLISH` / `EXISTING` / `NEW` |

Those `allowedValues` are the part a loaded model cannot provide. A model shows
the values it happens to use; bSDD shows the values the property is *allowed* to
take, which is what a specification needs to constrain.

Two facts forced the design:

1. **bSDD sends no CORS headers.** Verified both ways — a `GET` with an `Origin`
   header comes back with no `Access-Control-Allow-Origin`, and the preflight is
   not answered. A browser cannot call it directly, whatever the CSP says.
2. **It is a third-party origin**, which under `AGENTS.md` §7 needs the CSP
   updated and an ADR written. This is the ADR.

## Decision

**Proxy bSDD through our own origin, and make dictionary selection opt-in.**

- `app/api/bsdd/route.ts` forwards to `https://api.bsdd.buildingsmart.org` with
  a three-entry allow-list (`/api/Dictionary/v1`, `/api/Class/Search/v1`,
  `/api/Class/v1`) and a one-hour cache. Anything else is a 400.
- Because the proxy is same-origin, **`connect-src 'self'` already covers it and
  the CSP does not change.** No third-party origin is added to
  `next.config.ts` or `nginx.conf`.
- **No dictionary is selected by default**, and nothing is requested from bSDD
  until the author picks one. Suggesting IFC property sets to someone working to
  a national classification is worse than suggesting nothing.
- Suggestions fire on the **class a facet already names**, not on keystrokes.
  There is no search-as-you-type against bSDD, so no stream of partial input
  leaves the deployment.
- bSDD's vocabulary is **merged after** the model's, never instead of it. A
  property this model demonstrably has is a safer suggestion than one a
  dictionary says it ought to.

## What leaves the machine

This is the first feature that sends anything derived from the user's work to a
third party, so it is worth being exact.

**Leaves:** the dictionary search text the author types in the picker, and the
IFC class names their specification already names (`IFCWALL`). **Does not
leave:** any model, any geometry, any IDS document, any property *value*, and
any file. The suggestion lookup is class-name in, vocabulary out.

IFC class names are shared vocabulary rather than project data, so the exposure
is small — but it is not zero, and a bespoke classification code typed into the
dictionary search could carry more meaning than `IFCWALL` does. Two things
bound it: the feature is off until switched on, and the proxy means bSDD sees
**the deployment's IP address, not the user's**.

This does not weaken the §1 rule. Model, issue and specification payloads still
never leave the browser; what crosses the network here is vocabulary the author
typed, in a feature they had to turn on.

## What bSDD cannot tell us, and why that matters

The editor fills a facet's `dataType` and `uri` from bSDD. The URI is exact —
bSDD gives a class-scoped one, `.../class/IfcWall/prop/Pset_WallCommon/Status`,
which is precisely what the facet constrains. The data type is not, and the gap
is dangerous enough to record.

bSDD's `dataType` vocabulary is `String`, `Real`, `Boolean`, `Integer`, `Time`.
Measured on `IfcWall`: **110 of 233 properties are `Real`** — among them
`ThermalTransmittance`, which IFC stores as `IfcThermalTransmittanceMeasure`,
not `IfcReal`.

IDS matches a property *by its measure type*. A facet saying `IFCREAL` against a
model storing `IfcThermalTransmittanceMeasure` matches **no elements**, and a
specification that applies to nothing is reported as a **pass**. So the obvious
mapping `Real → IFCREAL` would have turned a helper into a generator of
silently-vacuous specifications — the exact failure this feature exists to
prevent, now arriving with the authority of a dictionary behind it.

`idsDataType()` therefore maps only the four unambiguous types and returns
nothing for `Real`, and the editor says why rather than leaving the field
mysteriously blank. **A wrong suggestion is worse than no suggestion**, because
an author who trusts the tool stops checking.

## Consequences

- The editor is useful before a model exists, which is when most IDS files are
  actually written.
- A new dependency on an external service — but a **soft** one. Every lookup
  fails to an empty suggestion list; the editor and the validator work exactly
  as before with bSDD unreachable, and the e2e suite has one test asserting the
  page is usable with no dictionary chosen and no request made.
- The allow-list has to grow if we want more of the bSDD API. That is
  deliberate: it makes each addition a visible decision.
- `/privacy` gains an entry. A privacy page that omits the one feature that
  talks to a third party is worse than no privacy page.
