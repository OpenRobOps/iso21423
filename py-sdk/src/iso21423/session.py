import json
import logging
import threading
from typing import Callable

from .constants import LOST_CONNECTION_STATE
from .errors import AuthorizationDenied, Iso21423Error
from .rate_gate import RateGate
from .schema.validators import MessageKind, assert_valid
from .timestamps import now_timestamp
from .topics import (RESOURCE_CONFIG, ParsedTopic, disconnection_topic, parse_topic,
                     topic_filter_matches, topic_for)
from .transport import Transport, Will

_log = logging.getLogger(__name__)
_EVENTS = ("connection", "validation_warning", "error")


def _dumps(payload) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class Session:
    """One MQTT connection for a single entity: retained on-change dedupe, republish on reconnect,
    rate-gated streaming resources, Last Will, and topic-scoped subscriptions. Thread-safe publishing."""

    def __init__(self, transport: Transport, entity_type: str, entity_uuid: str, validate_outbound: bool):
        self._t = transport
        self.entity_type, self.entity_uuid = entity_type, entity_uuid
        self._validate = validate_outbound
        # RLock held across publish so cache order == broker order (publish only queues)
        self._lock = threading.RLock()
        self._retained: dict[str, tuple[str, int]] = {}
        self._gates: dict[str, RateGate] = {}
        self._subs: list[tuple[str, Callable[[str, ParsedTopic], None]]] = []
        self._listeners: dict[str, list[Callable]] = {e: [] for e in _EVENTS}
        self._was_connected = False
        self._state = "closed"

    @classmethod
    def connect(cls, transport: Transport, entity_type: str, entity_uuid: str, *,
                username: str | None = None, password: str | None = None,
                validate_outbound: bool = True) -> "Session":
        s = cls(transport, entity_type, entity_uuid, validate_outbound)
        transport.on_message(s._dispatch)
        transport.on_connection_state(s._on_state)
        will_topic = disconnection_topic(entity_type, entity_uuid)
        transport.connect(f"iso21423-{entity_type}-{entity_uuid}", False, 60, username, password,
                          Will(will_topic, _dumps({"states": [LOST_CONNECTION_STATE]}), 1, True))
        s.clear_retained(will_topic)  # stale LWT from a prior crash (spec 4)
        return s

    def on(self, event: str, cb: Callable) -> None:
        self._listeners[event].append(cb)

    @property
    def connection_state(self) -> str:
        return self._state

    def _emit(self, event: str, *args) -> None:
        for cb in list(self._listeners[event]):
            cb(*args)

    def _emit_error(self, err: Exception) -> None:
        if self._listeners["error"]:
            self._emit("error", err)
        else:
            _log.error("iso21423 session error: %r", err)

    def publish_resource(self, resource: str, kind: MessageKind | None, payload) -> None:
        cfg = RESOURCE_CONFIG.get(resource)
        if cfg is None:
            raise Iso21423Error(f'unknown resource "{resource}"')
        if kind and self._validate:
            assert_valid(kind, payload)
        topic = topic_for(self.entity_type, self.entity_uuid, resource)
        body = _dumps(payload)
        if cfg.retain:
            with self._lock:
                if self._retained.get(topic, (None,))[0] == body:  # on-change rule
                    return
                self._retained[topic] = (body, cfg.qos)
                try:
                    self._t.publish(topic, body, cfg.qos, True)
                except Exception:
                    self._retained.pop(topic, None)
                    raise
        elif cfg.max_hz is not None:
            with self._lock:
                gate = self._gates.get(topic)
                if gate is None:
                    gate = self._gates[topic] = RateGate(cfg.max_hz)

            def emit(b):
                try:
                    self._t.publish(topic, b, cfg.qos, False)
                except Exception as e:  # fire-and-forget: reported, not raised
                    self._emit_error(e)
            gate.offer(body, emit)
        else:
            self._t.publish(topic, body, cfg.qos, False)

    def publish_topic(self, topic: str, kind: MessageKind | None, payload, qos: int, retain: bool) -> None:
        if kind and self._validate:
            assert_valid(kind, payload)
        self._t.publish(topic, _dumps(payload), qos, retain)

    def clear_retained(self, topic: str) -> None:
        with self._lock:
            self._retained.pop(topic, None)
            self._t.publish(topic, "", 1, True)

    def subscribe(self, filter: str, handler: Callable[[str, ParsedTopic], None], qos: int) -> None:
        if not self._t.subscribe(filter, qos):
            raise AuthorizationDenied(f"subscription denied by broker: {filter}")
        with self._lock:
            self._subs.append((filter, handler))

    def report_validation_warning(self, topic: str, payload: str, errors: list) -> None:
        self._emit("validation_warning", topic, payload, errors)

    def close(self, final_states: list[str] | None = None) -> None:
        try:
            if final_states is not None:
                self.publish_resource("status", "entityStatus", {
                    "entityId": self.entity_uuid, "timestamp": now_timestamp(), "states": final_states})
        finally:
            with self._lock:
                gates = list(self._gates.values())
            for g in gates:
                g.dispose()
            self._t.close()

    def _dispatch(self, topic: str, payload: bytes) -> None:
        parsed = parse_topic(topic)
        if parsed is None:
            return
        text = payload.decode("utf-8", errors="replace")
        with self._lock:
            subs = list(self._subs)
        for filt, handler in subs:
            if topic_filter_matches(filt, topic):
                try:
                    handler(text, parsed)
                except Exception as e:
                    self._emit_error(e)

    def _on_state(self, state: str) -> None:
        self._state = state
        self._emit("connection", state)
        if state != "connected":
            return
        reconnect, self._was_connected = self._was_connected, True
        if not reconnect:
            return
        try:
            with self._lock:
                for topic, (body, qos) in list(self._retained.items()):
                    self._t.publish(topic, body, qos, True)
                self.clear_retained(disconnection_topic(self.entity_type, self.entity_uuid))  # our LWT fired
        except Exception as e:
            self._emit_error(e)
