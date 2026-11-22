"""buildingSMART's validation service, one stage at a time, inside Pyodide (ADR 018).

The service (`buildingSMART/validate`, `backend/apps/ifc_validation/tasks/`) runs
each stage as a subprocess: `python -m ifcopenshell.simple_spf`, `python -m
ifcopenshell.validate`, `validate_header.py`, `check_gherkin.py`. Pyodide has no
subprocesses, so this runs the same modules in-process with the same arguments,
and turns their output into outcomes the way the service's `processing/` does.
Each function returns a JSON string: {"stage", "status", "outcomes", "info"}.

Layout in Pyodide's file system (from `rules.zip`, `npm run validator:assets`):
  /validator/rules            ifc-gherkin-rules at the service's commit (+ its data model)
  /validator/header_policy    the service's header check
  /validator/rules/features/custom   our own rules (DiCE-IFC-Rules), when built with them;
                              their steps in features/steps/dice_custom_steps
  /validator/custom_rules.json       what was built of them (build-validator-assets.mts)
  site-packages               ifcopenshell (wheel), simple_spf, the rtree/pyproj stand-ins
"""
import base64
import contextlib
import functools
import io
import json
import os
import re
import runpy
import sys
import time

# Import ifcopenshell now, with whatever it prints at import time discarded:
# without sqlite3 (not shipped: only `.ifcsqlite` reading needs it) it prints
# "No SQL support" to stdout, which inside a stage's captured output would read
# as a syntax error. Imported here, the stages' output is only theirs.
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    import ifcopenshell  # noqa: F401
    import ifcopenshell.simple_spf  # noqa: F401
    import ifcopenshell.validate  # noqa: F401

RULES_DIR = "/validator/rules"
RULE_DOCS = "https://buildingsmart.github.io/ifc-gherkin-rules/branches/main/features/"
HEADER_DIR = "/validator/header_policy"

# `stage` -> the service's ValidationTask type and how it runs.
RULE_TAGS = {
    "prerequisites": "@critical",
    "normative_ia": "@implementer-agreement",
    "normative_ip": "@informal-proposition",
    "industry_practices": "@industry-practice",
}

# Our own rules: run by path, all of them, in their own stage; never in buildingSMART's.
CUSTOM_STAGE = "dice_rules"
CUSTOM_FEATURES = "features/custom/"
CUSTOM_META = "/validator/custom_rules.json"

SEVERITY_ORDER = {"NOT_APPLICABLE": 0, "EXECUTED": 1, "PASSED": 2, "WARNING": 3, "ERROR": 4}


class _Capture(io.StringIO):
    """stdout/stderr for an in-process run. `ifcopenshell.validate`'s CLI calls
    `sys.stdout.reconfigure(encoding="utf-8")`, which a plain StringIO lacks."""

    def reconfigure(self, **_kwargs):
        pass


def _run(target, argv, *, path=False):
    """`python -m target argv` (or `python target argv` with path=True), in-process.
    Returns (exit code, stdout, stderr)."""
    out, err = _Capture(), _Capture()
    old_argv, old_cwd = sys.argv, os.getcwd()
    sys.argv = [target] + list(argv)
    code = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                if path:
                    os.chdir(os.path.dirname(target))
                    runpy.run_path(target, run_name="__main__")
                else:
                    runpy.run_module(target, run_name="__main__", alter_sys=False)
            except SystemExit as exit_:
                code = exit_.code if isinstance(exit_.code, int) else (0 if exit_.code is None else 1)
    finally:
        sys.argv = old_argv
        os.chdir(old_cwd)
    return code, out.getvalue(), err.getvalue()


def _result(stage, outcomes, started, **info):
    worst = max((SEVERITY_ORDER[o["severity"]] for o in outcomes), default=SEVERITY_ORDER["PASSED"])
    status = "invalid" if worst == SEVERITY_ORDER["ERROR"] else "warning" if worst == SEVERITY_ORDER["WARNING"] else "valid"
    if info.get("status"):
        status = info.pop("status")
    return json.dumps({"stage": stage, "status": status, "outcomes": outcomes,
                       "info": {**info, "seconds": round(time.time() - started, 2)}}, default=str)


# ---------------------------------------------------------------------------
# Syntax: `ifcopenshell.simple_spf --json [--only-header]`, as processing/syntax.py
# ---------------------------------------------------------------------------

def _syntax(stage, path, only_header):
    started = time.time()
    argv = ["--json"] + (["--only-header"] if only_header else []) + [path]
    _code, output, error_output = _run("ifcopenshell.simple_spf", argv)
    success = not [line for line in output.split("\n") if line] and not error_output
    if success:
        outcomes = [{"severity": "PASSED", "outcome_code": "P00010"}]
    elif error_output:
        outcomes = [{"severity": "ERROR", "outcome_code": "E00001",
                     "observed": [line for line in error_output.split("\n") if line][-1]}]
    else:
        outcomes = [{"severity": "ERROR", "outcome_code": "E00001", "observed": message.get("message"),
                     "instance": message.get("lineno"), "detail": message}
                    for message in json.loads(output)]
    return _result(stage, outcomes, started)


def header_syntax(path):
    return _syntax("header_syntax", path, True)


def syntax(path):
    return _syntax("syntax", path, False)


# ---------------------------------------------------------------------------
# Header: validate_header.py, as processing/header.py
# ---------------------------------------------------------------------------

HEADER_DOC = "https://github.com/buildingSMART/IFC4.x-IF/tree/main/docs/IFC-file-header"
# Fields the service's processing/header.py treats as making the header invalid;
# the others are recorded but do not (shown here as warnings).
HEADER_MARKERS = ("originating_system", "version", "company_name", "application_name")
# Read from FILE_NAME's originating system ("Company - Application - Version").
HEADER_DERIVED = ("company_name", "application_name", "version")


def header(path):
    started = time.time()
    if HEADER_DIR not in sys.path:
        sys.path.insert(0, HEADER_DIR)
    _code, output, _err = _run(os.path.join(HEADER_DIR, "validate_header.py"), [path], path=True)
    record = {}
    for line in output.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
    errors = list(dict.fromkeys(record.get("validation_errors", []) or []))  # once each, in order
    schema_id = record.get("schema_identifier") or ""
    outcomes = []
    for field in errors:
        outcome = {"severity": "ERROR" if field in HEADER_MARKERS else "WARNING", "outcome_code": "E00020",
                   "feature": field, "observed": record.get(field), "doc": HEADER_DOC}
        if field in HEADER_DERIVED:
            # Empty or wrong because of what the originating system says: name it.
            outcome["source"] = record.get("originating_system")
        if field == "description":
            outcome.update(_description_finding(path, record, schema_id))
        outcomes.append(outcome)
    if not outcomes:
        outcomes = [{"severity": "PASSED", "outcome_code": "P00010"}]
    status = "invalid" if any(field in HEADER_MARKERS for field in errors) else "valid"
    return _result("header", outcomes, started, header=record, status=status)


# An entry of FILE_DESCRIPTION as ifcopenshell.util.mvd_info's grammar reads it: "Keyword [value]".
_DESCRIPTION_ENTRY = re.compile(r"\s*[A-Za-z0-9_]+\s*\[[^\[\]]*\]\s*")


def _description_finding(path, record, schema_id):
    """
    Why validate_header.py rejected FILE_DESCRIPTION: it reads the view definitions
    with IfcOpenShell's grammar, which parses every entry as "Keyword [value]" — one
    entry that is not (free text, say) and none is found, however right the
    ViewDefinition entry is. Then each view must be allowed for the schema, and an
    add-on view needs a coordination view.
    """
    entries = _file_description(path)
    allowed = _allowed_views(schema_id)
    views = [v.strip() for v in (record.get("mvd") or "").split(",") if v.strip()]
    finding = {"observed": entries, "expected": allowed, "schema": schema_id}
    if not entries:
        finding["reason"] = "empty"
    elif not views:
        unreadable = [e for e in entries if not _DESCRIPTION_ENTRY.fullmatch(e)]
        if unreadable:
            finding.update(reason="unreadable", unreadable=unreadable)
        elif not any(re.match(r"\s*ViewDefinition\s*\[", e) for e in entries):
            finding["reason"] = "noView"
        else:
            # A ViewDefinition entry whose names use characters the grammar does not allow.
            finding.update(reason="unreadable", unreadable=[e for e in entries if re.match(r"\s*ViewDefinition\s*\[", e)])
    else:
        finding["views"] = views
        if [v for v in views if v not in allowed and "AddOnView" not in v]:
            finding["reason"] = "notAllowed"
        elif any("AddOnView" in v for v in views) and not any("CoordinationView" in v for v in views):
            finding["reason"] = "addOn"
        else:
            finding["reason"] = "type"  # IfcOpenShell's own check of the attribute's type
    return finding


def _file_description(path):
    """FILE_DESCRIPTION's description entries, from the header, as written (STEP '' unescaped)."""
    with open(path, "rb") as handle:
        head = handle.read(65536).decode("latin-1")
    match = re.search(r"FILE_DESCRIPTION\s*\(\s*\(", head, re.I)
    if not match:
        return []
    entries, position = [], match.end()
    token = re.compile(r"\s*(?:'((?:[^']|'')*)'|(,)|(\)))")
    while (found := token.match(head, position)):
        position = found.end()
        if found.group(3):
            break
        if found.group(1) is not None:
            entries.append(found.group(1).replace("''", "'"))
    return entries


def _allowed_views(schema_id):
    """The view definitions the header policy accepts for a schema (valid_descriptions.yaml)."""
    try:
        import yaml

        with open(os.path.join(HEADER_DIR, "valid_descriptions.yaml"), encoding="utf-8") as handle:
            return list(yaml.safe_load(handle).get(schema_id, []))
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Schema: `ifcopenshell.validate --json --rules --fields`, as processing/schema.py
# ---------------------------------------------------------------------------

def _schema_identifier(path):
    """FILE_SCHEMA's identifier, from the header (the first few kilobytes)."""
    with open(path, "rb") as handle:
        head = handle.read(65536).decode("latin-1")
    match = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", head, re.I)
    return match.group(1).upper() if match else ""


def _ifc_doc(schema_id, name):
    """The IFC documentation page of an entity or type, for the schema the file declares."""
    if not name or not re.fullmatch(r"Ifc[A-Za-z0-9]+", name):
        return None
    if schema_id.startswith("IFC4X3"):
        return f"https://standards.buildingsmart.org/IFC/DEV/IFC4_3/HTML/lexical/{name}.html"
    if schema_id.startswith("IFC4"):
        return f"https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/{name.lower()}.htm"
    return None


def _schema_parts(text):
    """ifcopenshell.validate's message, in its parts.

    `On instance:` messages (a type's rule) read: the instance, a caret line,
    "<title>:", the sentence that says what is required, "Violated by:" and why.
    Entity and global rules read: the EXPRESS expression, "Violated by:" and its
    evaluation. "Attribute not optional" and the like are one line.
    """
    text = text or ""
    head, _, violated = text.partition("\nViolated by:\n")
    detail = "\n".join(line.strip() for line in violated.split("\n") if line.strip()) or None
    if head.startswith("On instance:"):
        lines = head.split("\n")
        rest = lines[3:] if len(lines) > 3 else []
        title = rest[0].strip().rstrip(":") if rest else None
        sentence = " ".join(line.strip() for line in rest[1:] if line.strip()) or None
        return {"title": title, "explanation": sentence, "detail": detail}
    if violated:
        return {"expression": head.strip(), "detail": detail}
    return {"title": text.strip() or None}


def schema(path):
    started = time.time()
    schema_id = _schema_identifier(path)
    _code, output, _err = _run("ifcopenshell.validate", ["--json", "--rules", "--fields", "--recursion-limit", "10000", path])
    outcomes = []
    for line in output.split("\n"):
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict) or message.get("level") == "info":
            continue
        instance = message.get("instance") or {}
        attribute = message.get("attribute")
        parts = _schema_parts(message.get("message"))
        # The entity or type the finding is about: the rule's or attribute's owner, else the type in the title.
        subject = attribute.split(".")[0] if attribute else (parts.get("title") or "").split(" ")[0]
        outcomes.append({
            "severity": "ERROR", "outcome_code": "E00002", "observed": message.get("message"),
            "feature": json.dumps({"type": message.get("type"), "attribute": attribute}),
            "inst": instance.get("id"), "entity": instance.get("type"),
            "attribute": attribute, "type": message.get("type"),
            **parts,
            "doc": _ifc_doc(schema_id, subject),
            "schema": schema_id,
        })
    if not outcomes:
        outcomes = [{"severity": "PASSED", "outcome_code": "P00010"}]
    return _result("schema", outcomes, started)


# ---------------------------------------------------------------------------
# Rules: ifc-gherkin-rules' `main.run`, without the subprocess
# ---------------------------------------------------------------------------

_model_cache = {}


def _cache_model_opens():
    """Each feature reopens the model (`environment.read_model`); the rules only
    read it, so 104 parses of the same file become one. Results are unchanged."""
    import ifcopenshell

    if getattr(ifcopenshell.open, "_dice_cached", False):
        return
    original = ifcopenshell.open

    @functools.wraps(original)
    def cached(path, *args, **kwargs):
        key = (path, args, tuple(sorted(kwargs.items())))
        if key not in _model_cache:
            _model_cache.clear()
            _model_cache[key] = original(path, *args, **kwargs)
        return _model_cache[key]

    cached._dice_cached = True
    ifcopenshell.open = cached


def _reduce(outcomes):
    """As production keeps a rule's outcomes (environment.py, reduce_db_outcomes):
    its distinct warnings and errors, or else one passed / executed / not applicable."""
    failed = [o for o in outcomes if o.get("severity") in ("WARNING", "ERROR")]
    if failed:
        seen, kept = set(), []
        for o in failed:
            key = json.dumps({k: o.get(k) for k in ("severity", "outcome_code", "inst", "observed", "expected")},
                             sort_keys=True, default=str)
            if key not in seen:
                seen.add(key)
                kept.append(o)
        return kept
    for severity in ("PASSED", "EXECUTED", "NOT_APPLICABLE"):
        found = next((o for o in outcomes if o.get("severity") == severity), None)
        if found:
            return [found]
    return []


def _custom_rules():
    """What was built of our own rules, or None."""
    try:
        with open(CUSTOM_META, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _rule_doc(location, custom):
    """A rule's page: buildingSMART's published one, or our rule's file on GitHub."""
    if not location.endswith(".feature"):
        return None
    if location.startswith(CUSTOM_FEATURES):
        docs = (custom or {}).get("docs")
        return docs + "features/rules/" + location[len(CUSTOM_FEATURES):] if docs else None
    return RULE_DOCS + os.path.basename(location).replace(".feature", ".html")


def rules(stage, path):
    started = time.time()
    custom = _custom_rules()
    if stage == CUSTOM_STAGE:
        if not custom:
            return _result(stage, [], started, status="skipped", reason="none")
        # All of ours, whatever their tags (@industry-practice only makes a rule's findings warnings).
        selection = ["--include", CUSTOM_FEATURES]
    else:
        # The service's selection, by tag, of the service's rules only.
        selection = [f"--tags={RULE_TAGS[stage]}", "--exclude", CUSTOM_FEATURES]
    if RULES_DIR not in sys.path:
        sys.path.insert(0, RULES_DIR)
    _cache_model_opens()
    from behave.__main__ import main as behave_main

    out_json = "/tmp/dice-behave.json"
    args = selection + ["--tags=-disabled",
            "--define", f"input={path}",
            "--define", "max_outcomes_per_rule=0",
            "--define", f"purepythonparser={'true' if stage == 'prerequisites' else 'false'}",
            "-f", "outcome_embedding_json", "-o", out_json, "--no-summary"]
    old_cwd = os.getcwd()
    os.chdir(RULES_DIR)
    if os.path.exists(out_json):
        os.remove(out_json)
    # Our rules' steps are loaded only in their stage (features/steps/zz_dice_custom_steps.py).
    os.environ["DICE_RULES_STAGE"] = "1" if stage == CUSTOM_STAGE else "0"
    out, err = _Capture(), _Capture()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                behave_main(args)
            except SystemExit:
                pass
    finally:
        os.chdir(old_cwd)
        os.environ.pop("DICE_RULES_STAGE", None)

    if not os.path.exists(out_json):
        # behave stopped before running a rule: an ambiguous or broken step, a feature it cannot parse.
        said = [line for line in (err.getvalue() + out.getvalue()).splitlines() if line.strip()]
        raise RuntimeError(said[-1][:300] if said else "the rules did not run")
    with open(out_json, encoding="utf-8") as handle:
        log = json.load(handle)

    model = _model_cache and next(iter(_model_cache.values()))
    outcomes, crashed = [], []
    for feature in log:
        rule = feature["name"].split(" - ")[0].strip()
        title = feature["name"]
        # The service links each rule to its published page, named after the feature file; ours, to the file.
        location = (feature.get("location") or "").split(":")[0]
        doc = _rule_doc(location, custom)
        # The rule's own words ("The rule verifies that…"), as the service shows them.
        description = " ".join(line.strip() for line in feature.get("description", []) if line.strip()) or None
        found = []
        for element in [feature] + feature.get("elements", []):
            for blob in element.get("validation_outcomes", []):
                found.extend(json.loads(base64.b64decode(blob["data"]).decode("utf-8")))
            for st in element.get("steps", []):
                if (st.get("result") or {}).get("status") == "undefined":
                    # A phrase no step matches (a typo, say): the rule checks nothing, so say so.
                    crashed.append({"rule": rule, "step": st.get("name"), "error": f"no step matches “{st.get('name')}”"})
                    continue
                message = (st.get("result") or {}).get("error_message")
                if message and (st.get("result") or {}).get("status") == "failed" and "ValidationOutcome(" not in str(message):
                    text = message[-1] if isinstance(message, list) else str(message)
                    crashed.append({"rule": rule, "step": st.get("name"), "error": text.strip().splitlines()[-1][:300]})
        for o in _reduce(found):
            entity = None
            if o.get("inst") and model:
                try:
                    entity = model.by_id(int(o["inst"])).is_a()
                except Exception:
                    entity = None
            outcomes.append({**o, "rule": rule, "title": title, "entity": entity, "doc": doc, "description": description,
                             "tags": [t for t in feature.get("tags", [])]})
    return _result(stage, outcomes, started, rules=len(log), crashed=crashed)


def prerequisites(path):
    return rules("prerequisites", path)


def normative_ia(path):
    return rules("normative_ia", path)


def normative_ip(path):
    return rules("normative_ip", path)


def industry_practices(path):
    return rules("industry_practices", path)


def dice_rules(path):
    return rules(CUSTOM_STAGE, path)


STAGES = {
    "header_syntax": header_syntax,
    "header": header,
    "syntax": syntax,
    "prerequisites": prerequisites,
    "schema": schema,
    "normative_ia": normative_ia,
    "normative_ip": normative_ip,
    "industry_practices": industry_practices,
    CUSTOM_STAGE: dice_rules,
}


def run_stage(stage, path):
    return STAGES[stage](path)
