# ADR 018 — buildingSMART's IFC validation, in the browser

**Status:** accepted (2026-11-19) — all eight local stages, a viewer panel; BCF and PDF exports (2026-11-19).

## Context

buildingSMART's validation service (`buildingSMART/validate`) checks an IFC file
for syntax, header, schema and its normative rules (ifc-gherkin-rules). Using it
means uploading the model, which this application never does (AGENTS.md §1).
The checks are Python: IfcOpenShell, `behave` running 104 Gherkin rules, and a
pydantic header policy.

## Decision

**Run the service's own Python code in the browser, on Pyodide, in a Web Worker.**
Not a port: the rules change with every release, and a re-implementation drifts
(a hand-written check for a few rules already disagreed with the service on two).

- **Stages** — header syntax, header, syntax, prerequisites, schema, normative
  rules (implementer agreements, informal propositions), industry practices —
  in the service's order with its blocking (`configs.py`), each run in-process
  with the arguments the service passes its subprocess
  (`validator/python/dice_validator.py`). Rule outcomes are reduced as production
  saves them (`reduce_db_outcomes`).
- **Pinned to the service.** ifc-gherkin-rules `893f827`, its data model
  `cad20d3`, the header policy from `validate@5ceadbc`, pyproj's EPSG data from
  3.7.1. ifcopenshell is 0.8.5, the newest Pyodide build; the service runs
  0.8.6 `8b5b400` (whose pure-Python `simple_spf` is vendored).
- **Served from this origin** (`public/validator/`, built by
  `scripts/build-validator-assets.mts` from `validator/manifest.json`, every
  download checked by SHA-256 — Pyodide's own packages against its lockfile).
  `connect-src 'self'` and the worker CSP (ADR 015) are unchanged; Pyodide needs
  only `'wasm-unsafe-eval'`, already there.
- **Two stand-ins** for C libraries Pyodide lacks: `rtree` (a brute-force box
  index, same answers) and `pyproj` (a table generated with the real pyproj 3.7.1;
  identical on all 7 013 EPSG codes and on every string form tested).

## Not included

The virus scan (the file never leaves), digital signatures (`lib/signing/`
checks them), bSDD (it would send classification references to a third party —
needs its own decision under §1).

## Consequences

- About **37 MB** downloaded on first use (ifcopenshell 15, Pyodide 9), then
  cached by the browser. Nothing is loaded until "Validate". **Amended
  2026-11-19:** it was 61 MB; Django, pyspellchecker, pandas, SQLAlchemy and a
  few others listed in the rules' requirements are not shipped — the rules use
  them only for production's database or their own TESTING mode — with a
  Django-free `validation_results.py` in place of theirs. Same outcomes on three
  models, every stage, with a fixed hash seed (`PYTHONHASHSEED=0`, now always
  set: the rules' set orderings otherwise vary run to run).
- Time: the 6.9 MB example model takes ~2¼ min for all stages (most of it the
  normative rules); a small model ~20 s, plus Pyodide's start.
- Builds need network once (cached in `.cache/validator/`); without it the
  validator is left out and the panel says so.
- Parity is checked with `npm run validator:check -- model.ifc`, which runs the
  built assets under Node, and `e2e/ifc-validation.spec.ts` in the browser.
- Known upstream issue: GRP001 raises `KeyError` on `IfcGroup` subtypes
  (`IfcZone`); reported as a rule error, not a model error.
- **Amended 2026-11-19, explanations:** the service's findings are terse
  ("Header4Invalid originating_system", a schema message as IfcOpenShell prints
  it). Each is now explained in the user's language (`lib/validation/explain.ts`)
  from what the driver adds without changing an outcome: for the header, the
  field's rule, the value found, the originating system a derived field comes
  from, and which FILE_DESCRIPTION check failed; for the schema, the message's
  parts and the IFC documentation of the entity; for the rules, the feature
  file's description. The raw message stays under "Technical details".
- **Amended 2026-11-19, custom rules:** our own rules (the DiCE-IFC-Rules
  repository: ifc-gherkin-rules' format and step phrases) run as one more stage,
  `dice_rules`, after industry practices and blocked by what blocks them. They
  are pinned and hashed like the service's archives (`customRules` in the
  manifest) and shipped in `validator.zip`, so nothing is fetched at run time and
  §1 is unchanged. The service's stages exclude them by path and load none of
  their Python steps, so buildingSMART's results are the same with or without
  them (checked on the fixture and the example model). A rule's documentation
  link goes to its file on GitHub at the pinned commit. Rules shipped to the
  browser are public, whatever the repository's visibility.
