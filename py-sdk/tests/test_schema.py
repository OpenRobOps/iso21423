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

from pathlib import Path

import pytest

from iso21423.errors import ValidationError
from iso21423.schema import assert_valid, validate_message

PKG = Path(__file__).parent.parent / "src/iso21423"
REPO = Path(__file__).parent.parent.parent
UUID = "123e4567-e89b-42d3-a456-426614174000"
TS = "2025-04-08T12:34:56.789Z"
ODOM = {
    "timestamp": TS,
    "pose": {"locationPoint": {"ccsId": UUID, "x": 1.0, "y": 2.0, "z": 0.0},
             "orientation": {"yaw": 0.1, "pitch": 0.0, "roll": 0.0}},
    "velocity": {"linear": 0.5, "angular": 0.0},
}
BATTERY = {"timestamp": TS, "batterySoc": 0.8}


def test_schema_copy_identical_to_ts():
    ts = REPO / "ts-sdk/src/schema/iso21423.schema.json"
    if not ts.exists():
        pytest.skip("not in repo checkout")
    assert ts.read_bytes() == (PKG / "schema/iso21423.schema.json").read_bytes()


def test_valid_odometry():
    r = validate_message("odometry", ODOM)
    assert r.ok, r.errors


def test_invalid_rejected():
    r = validate_message("batteryStatus", {"timestamp": "x"})
    assert not r.ok and r.errors


def test_comma_timestamp_normalized():
    r = validate_message("batteryStatus", {**BATTERY, "timestamp": "2025-04-08T12:34:56,789Z"})
    assert r.ok and r.value["timestamp"] == TS and r.warnings


def test_status_legacy_id_renamed():
    r = validate_message("entityStatus", {"id": UUID, "timestamp": TS, "states": ["MODE_AUTO"]})
    assert r.ok and r.value["entityId"] == UUID and "id" not in r.value


def test_unknown_state_warns():
    r = validate_message("entityStatus", {"entityId": UUID, "timestamp": TS, "states": ["MODE_AUTO", "FOO"]})
    assert r.ok and any("FOO" in w for w in r.warnings)


def test_assert_valid_raises():
    with pytest.raises(ValidationError):
        assert_valid("odometry", {})


def test_bad_datetime_rejected():
    assert not validate_message("batteryStatus", {**BATTERY, "timestamp": "x"}).ok
    assert not validate_message("batteryStatus", {**BATTERY, "timestamp": "2025-13-45T12:00:00Z"}).ok
