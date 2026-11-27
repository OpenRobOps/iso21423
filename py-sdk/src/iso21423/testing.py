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

"""In-memory Transport for tests. Not a broker: no subscription routing, only recording and injection."""
from typing import Callable

from .transport import Will


class _ConnectArgs:
    def __init__(self, client_id, clean_session, keepalive, username, password, will: Will | None):
        self.client_id, self.clean_session, self.keepalive = client_id, clean_session, keepalive
        self.username, self.password, self.will = username, password, will


class FakeTransport:
    def __init__(self):
        self.published: list[tuple[str, str, int, bool]] = []
        self.retained: dict[str, str] = {}
        self.subscriptions: list[tuple[str, int]] = []
        self.grant = True
        self.closed = False
        self.connect_args: _ConnectArgs | None = None
        self._msg_cbs: list[Callable[[str, bytes], None]] = []
        self._state_cbs: list[Callable[[str], None]] = []

    def connect(self, client_id, clean_session, keepalive, username, password, will):
        self.connect_args = _ConnectArgs(client_id, clean_session, keepalive, username, password, will)
        self.set_state("connected")

    def publish(self, topic, payload, qos, retain):
        self.published.append((topic, payload, qos, retain))
        if retain:
            if payload:
                self.retained[topic] = payload
            else:
                self.retained.pop(topic, None)

    def subscribe(self, filter, qos):
        self.subscriptions.append((filter, qos))
        return self.grant

    def unsubscribe(self, filter):
        self.subscriptions = [s for s in self.subscriptions if s[0] != filter]

    def on_message(self, cb):
        self._msg_cbs.append(cb)

    def on_connection_state(self, cb):
        self._state_cbs.append(cb)

    def close(self):
        self.closed = True
        self.set_state("closed")

    def inject(self, topic: str, payload: str) -> None:
        for cb in self._msg_cbs:
            cb(topic, payload.encode())

    def set_state(self, state: str) -> None:
        for cb in self._state_cbs:
            cb(state)
