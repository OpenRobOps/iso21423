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

ROOT_NAMESPACE = "/ISO_21423/v1"
PROTOCOL_VERSION = "1.0"

# Stop categories, motion states and MODE_* markers mixed together.
KNOWN_OPERATING_STATES = (
    "STOP_CATEGORY_0", "STOP_CATEGORY_1", "STOP_CATEGORY_2",
    "PAUSED", "WAIT_FOR_RESET", "MAPPING", "LOST",
    "WAIT_FOR_ATTACHMENT", "WAIT_FOR_EVENT", "BLOCKED", "ATTACHMENT_ACTIVE",
    "STOPPED", "DOCKING", "SLOWING", "ACCELERATING",
    "LEFT_TURN", "RIGHT_TURN", "REVERSE", "FORWARD", "LINE_FOLLOWING",
    "CHARGING", "LOW_BATTERY", "IDLE", "PARKED", "OFFLINE",
    "READY", "NOT_READY",
    "MODE_AUTO", "MODE_SEMIAUTO", "MODE_TELEOP", "MODE_MANUAL", "MODE_MAINTENANCE",
)

# Mutually-exclusive MODE_* subset of KNOWN_OPERATING_STATES.
OPERATING_MODES = (
    "MODE_AUTO", "MODE_SEMIAUTO", "MODE_TELEOP", "MODE_MANUAL", "MODE_MAINTENANCE",
)

# LWT state published by the broker on ungraceful disconnect (B.4).
LOST_CONNECTION_STATE = "LOST_CONNECTION"

# Whole-request lifecycle (RECOVERY has no per-detail equivalent).
REQUEST_STATES = (
    "RECEIVED", "ACCEPTED", "EXECUTING", "CANCELED", "SUCCEEDED", "ABORTED", "RECOVERY",
)

# Lifecycle of a single detail/action within a request.
DETAIL_STATES = (
    "RECEIVED", "ACCEPTED", "EXECUTING", "CANCELED", "SUCCEEDED", "ABORTED",
)

KNOWN_REASON_CODES = (
    "OK", "GENERAL_FAILURE", "TIMEOUT", "VERSION_NOT_SUPPORTED", "FORMAT_NOT_SUPPORTED",
    "ACTION_NOT_IMPLEMENTED", "REJECTED", "MALFORMED_REQUEST", "INVALID_IMR_STATE_FOR_ACTION",
)

DEFAULT_PRIORITY = 100
BLOCKING_STATES = ("STOP_CATEGORY_0", "STOP_CATEGORY_1", "STOP_CATEGORY_2", "WAIT_FOR_RESET")
CONTROL_TYPES = frozenset({"pauseImr", "resumeImr"})
