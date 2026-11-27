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

import pytest

from iso21423.errors import IllegalTransition
from iso21423.state_machine import (
    REQUEST_TRANSITIONS, DetailLifecycle, RequestLifecycle, is_terminal_request_state,
)


def walk(lc, *states):
    for s in states:
        lc.transition(s)
    return lc


def test_happy_path():
    lc = RequestLifecycle()
    assert lc.state == "RECEIVED"
    walk(lc, "ACCEPTED", "EXECUTING", "SUCCEEDED")
    assert lc.is_terminal()


@pytest.mark.parametrize("end", ["ABORTED", "CANCELED"])
def test_recovery_exits(end):
    assert walk(RequestLifecycle(), "ACCEPTED", "EXECUTING", "RECOVERY", end).is_terminal()


def test_early_rejection():
    assert walk(RequestLifecycle(), "ABORTED").is_terminal()


def test_illegal_transition_raises():
    lc = RequestLifecycle()
    with pytest.raises(IllegalTransition):
        lc.transition("SUCCEEDED")
    walk(lc, "ACCEPTED", "EXECUTING", "SUCCEEDED")
    with pytest.raises(IllegalTransition):
        lc.transition("EXECUTING")
    with pytest.raises(IllegalTransition):
        RequestLifecycle().transition("RECOVERY")
    assert not lc.can_transition("ABORTED")


def test_table_names_only_known_states():
    for frm, tos in REQUEST_TRANSITIONS.items():
        assert set(tos) <= set(REQUEST_TRANSITIONS) and frm in REQUEST_TRANSITIONS


def test_detail_has_no_recovery():
    lc = walk(DetailLifecycle(), "ACCEPTED", "EXECUTING", "CANCELED")
    assert lc.is_terminal()
    with pytest.raises(IllegalTransition):
        DetailLifecycle().transition("RECOVERY")


def test_is_terminal_request_state():
    for s in ("CANCELED", "SUCCEEDED", "ABORTED"):
        assert is_terminal_request_state(s)
    for s in ("EXECUTING", "RECOVERY"):
        assert not is_terminal_request_state(s)
