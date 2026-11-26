import json
import re
from datetime import datetime
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources
from typing import Literal

from jsonschema import Draft202012Validator, FormatChecker

from ..constants import KNOWN_OPERATING_STATES
from ..errors import ValidationError
from .normalize import normalize_inbound

MessageKind = Literal[
    "entityIdentity", "entityStatus", "batteryStatus", "odometry",
    "localTrajectory", "globalPath", "globalPlan",
    "request", "requestStatus", "requestStatusArray",
]

_SCHEMA = json.loads(resources.files("iso21423.schema").joinpath("iso21423.schema.json").read_text("utf-8"))
_KNOWN_STATES = frozenset(KNOWN_OPERATING_STATES)


@dataclass
class ValidationResult:
    ok: bool
    value: object
    warnings: list[str] = field(default_factory=list)
    errors: list = field(default_factory=list)


_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")


def _format_checker():
    # jsonschema only checks date-time if the optional rfc3339-validator is installed; do it ourselves.
    fc = FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _date_time(v):
        if not isinstance(v, str):
            return True
        if not _RFC3339.match(v):
            raise ValueError(v)
        datetime.strptime(v[:19].replace("t", "T"), "%Y-%m-%dT%H:%M:%S")  # calendar/clock ranges
        return True

    return fc


@lru_cache(maxsize=None)
def _validator(kind):
    if kind not in _SCHEMA["$defs"]:
        raise ValueError(f"No schema for message kind: {kind}")
    ref = {"$ref": f"{_SCHEMA['$id']}#/$defs/{kind}"}
    fc = _format_checker()
    try:  # jsonschema >= 4.18 (older ones may still have `referencing` installed, so feature-detect the kwarg)
        from referencing import Registry, Resource
        reg = Registry().with_resource(_SCHEMA["$id"], Resource.from_contents(_SCHEMA))
        return Draft202012Validator(ref, registry=reg, format_checker=fc)
    except (ImportError, TypeError):  # jsonschema 4.10 .. 4.17
        from jsonschema import RefResolver
        return Draft202012Validator(ref, resolver=RefResolver.from_schema(_SCHEMA), format_checker=fc)


def validate_message(kind, raw) -> ValidationResult:
    """Normalize then validate `raw` against the schema for `kind`."""
    value, warnings = normalize_inbound(kind, raw)
    errors = list(_validator(kind).iter_errors(value))
    if kind == "entityStatus" and isinstance(value, dict) and isinstance(value.get("states"), list):
        warnings += [
            f'entityStatus: unknown operating state "{s}" (deployment extension?)'
            for s in value["states"] if isinstance(s, str) and s not in _KNOWN_STATES
        ]
    return ValidationResult(not errors, value, warnings, errors)


def assert_valid(kind, value) -> None:
    """Egress guard: raises ValidationError on non-conformant outbound payloads."""
    r = validate_message(kind, value)
    if not r.ok:
        raise ValidationError(f"outbound {kind} message is not ISO 21423 conformant", r.errors)
