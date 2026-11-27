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

"""Client: owns one lazily-opened session and the self entity (ports the self-entity part of core/client.ts)."""
from typing import Literal

from .entity import EntityHandle
from .errors import Iso21423Error
from .policies import ExecutionPolicy
from .sequence import FileSequenceStore, SequenceCounter, SequenceStore
from .session import Session
from .transport import PahoTransport, Transport

# client event -> session event
_EVENTS = {"connection": "connection", "diagnostic": "error", "validation_warning": "validation_warning"}


class Client:
    def __init__(self, transport: Transport, username, password, sequence_store):
        self._transport, self._username, self._password = transport, username, password
        self._store = FileSequenceStore() if sequence_store == "default" else sequence_store
        self._session: Session | None = None
        self._handle: EntityHandle | None = None
        self._listeners: list[tuple[str, object]] = []

    @classmethod
    def connect(cls, url: str | None = None, *, transport: Transport | None = None,
                username: str | None = None, password: str | None = None, tls: dict | None = None,
                sequence_store: SequenceStore | None | Literal["default"] = "default") -> "Client":
        if (url is None) == (transport is None):
            raise Iso21423Error('Client.connect requires exactly one of "url" or "transport"')
        if transport is None:
            transport = PahoTransport(url, username=username, password=password, tls=tls)
        return cls(transport, username, password, sequence_store)

    def on(self, event: str, cb) -> None:
        if event not in _EVENTS:
            raise Iso21423Error(f'unknown event "{event}"')
        self._listeners.append((event, cb))
        if self._session:
            self._session.on(_EVENTS[event], cb)

    def register_self_entity(self, entity_uuid: str, entity_type: str = "IMR", manufacturer_name: str = "",
                             details: dict | None = None, provides: list[str] = (), accepts: list[str] = (),
                             execution_policy: ExecutionPolicy | None = None) -> EntityHandle:
        if self._handle:
            raise Iso21423Error("a self entity is already registered on this client")
        session = Session.connect(self._transport, entity_type, entity_uuid,
                                  username=self._username, password=self._password)
        self._session = session
        for ev, cb in self._listeners:
            session.on(_EVENTS[ev], cb)
            if ev == "connection":  # connect() already reported the first state: replay it
                cb(session.connection_state)
        handle = EntityHandle(self._session, SequenceCounter.open(entity_uuid, self._store), entity_uuid,
                              entity_type, manufacturer_name, details, provides, accepts, execution_policy)
        self._handle = handle
        handle.publish_identity(handle.identity())
        return handle

    def close(self) -> None:
        if self._session is None:
            return
        session, self._session = self._session, None
        if self._handle:
            self._handle.stop_serving()
        session.close()
