"""Stand-in for pyspellchecker (ADR 018).

ifc-gherkin-rules imports it at start-up (`rule_creation_protocol/protocol.py`)
to spell-check the rule files themselves, in its TESTING mode only, which the
browser never runs. Importable, so the rules load; using it says why it is not
there. Saves 7 MB of dictionaries.
"""


class SpellChecker:
    def __init__(self, *_args, **_kwargs):
        raise NotImplementedError("pyspellchecker is not shipped: only ifc-gherkin-rules' TESTING mode uses it")
