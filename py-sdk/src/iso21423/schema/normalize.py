# Copyright 2026 InOrbit, Inc.
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS,
#    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#    See the License for the specific language governing permissions and
#    limitations under the License.

import re

_TIMESTAMP_KEYS = ("timestamp", "arrivalTime")
_COMMA_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d+)(Z|[+-]\d{2}:?\d{2})$")


def _fix(value, warnings, path):
    if isinstance(value, list):
        return [_fix(v, warnings, f"{path}[{i}]") for i, v in enumerate(value)]
    if not isinstance(value, dict):
        return value
    out = {}
    for k, v in value.items():
        if k in _TIMESTAMP_KEYS and isinstance(v, str) and _COMMA_TS.match(v):
            out[k] = _COMMA_TS.sub(r"\1.\2\3", v)
            warnings.append(f"{path}.{k}: comma-decimal timestamp normalized to dot form")
        else:
            out[k] = _fix(v, warnings, f"{path}.{k}")
    return out


def normalize_inbound(kind, value):
    """Best-effort cleanup before validation: comma-decimal timestamps and legacy
    entityStatus `id` -> `entityId`. Never raises; returns (value, warnings)."""
    warnings: list[str] = []
    v = _fix(value, warnings, kind)
    if kind == "entityStatus" and isinstance(v, dict) and "entityId" not in v and isinstance(v.get("id"), str):
        v = {("entityId" if k == "id" else k): x for k, x in v.items()}
        warnings.append('entityStatus: legacy field "id" renamed to "entityId" (spec §3.1)')
    return v, warnings
