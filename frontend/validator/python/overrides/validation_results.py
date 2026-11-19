"""ifc-gherkin-rules' `validation_results.py`, without Django (ADR 018).

The original runs `django.setup()` and takes `OutcomeSeverity` and
`ValidationOutcomeCode` from the service's Django model, because production writes
outcomes to its database (`environment.py`, `after_feature`, PRODUCTION only).
In the browser nothing is written: the rules only use the outcome dataclass
(`ifc_validation_models.dataclass_compat.ValidationOutcome`, Django-free) and the
two enums. So this shapes the enums exactly as Django's choices behave — same
names, same values, `str()` gives the value (it is what `to_dict` writes as the
outcome code), `.label` — and saves Django and its dependencies (8 MB).

`npm run validator:assets` packs this in place of the original; parity with the
original was checked on three models, every stage, byte for byte.
"""
from enum import Enum, IntEnum

from ifc_validation_models.dataclass_compat import ValidationOutcome  # noqa: F401  (re-exported, as the original does)


class OutcomeSeverity(IntEnum):
    """As the Django model's `ValidationOutcome.OutcomeSeverity` (IntegerChoices)."""

    EXECUTED = 1
    PASSED = 2
    WARNING = 3
    ERROR = 4
    NOT_APPLICABLE = 0

    @property
    def label(self):
        return {1: "Executed", 2: "Passed", 3: "Warning", 4: "Error", 0: "N/A"}[self.value]

    def __str__(self):
        return str(self.value)


class ValidationOutcomeCode(str, Enum):
    """As the Django model's `ValidationOutcome.ValidationOutcomeCode` (TextChoices)."""

    PASSED = "P00010"
    NOT_APPLICABLE = "N00010"

    SYNTAX_ERROR = "E00001"
    SCHEMA_ERROR = "E00002"
    TYPE_ERROR = "E00010"
    VALUE_ERROR = "E00020"
    GEOMETRY_ERROR = "E00030"
    CARDINALITY_ERROR = "E00040"
    DUPLICATE_ERROR = "E00050"
    PLACEMENT_ERROR = "E00060"
    UNITS_ERROR = "E00070"
    QUANTITY_ERROR = "E00080"
    ENUMERATED_VALUE_ERROR = "E00090"
    RELATIONSHIP_ERROR = "E00100"
    NAMING_ERROR = "E00110"
    REFERENCE_ERROR = "E00120"
    RESOURCE_ERROR = "E00130"
    DEPRECATION_ERROR = "E00140"
    SHAPE_REPRESENTATION_ERROR = "E00150"
    INSTANCE_STRUCTURE_ERROR = "E00160"

    ALIGNMENT_CONTAINS_BUSINESS_LOGIC_ONLY = "W00010"
    ALIGNMENT_CONTAINS_GEOMETRY_ONLY = "W00020"
    WARNING = "W00030"

    EXECUTED = "X00040"

    @property
    def label(self):
        return self.name.replace("_", " ").title()

    def __str__(self):
        return self.value


# The service's database models: production only, never reached here.
ValidationOutcomeDjango = None
ModelInstance = None
ValidationTask = None
