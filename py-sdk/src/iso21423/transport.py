import ssl
import threading
from dataclasses import dataclass
from typing import Callable, Protocol
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

from .errors import Iso21423Error


@dataclass(frozen=True)
class Will:
    """MQTT Last Will armed at connect time (B.4)."""
    topic: str
    payload: str
    qos: int
    retain: bool


class Transport(Protocol):
    """Broker-agnostic MQTT contract. State is one of connected|reconnecting|offline|closed."""

    def connect(self, client_id: str, clean_session: bool, keepalive: int,
                username: str | None, password: str | None, will: Will | None) -> None: ...
    def publish(self, topic: str, payload: str, qos: int, retain: bool) -> None: ...
    def subscribe(self, filter: str, qos: int) -> bool: ...
    def unsubscribe(self, filter: str) -> None: ...
    def on_message(self, cb: Callable[[str, bytes], None]) -> None: ...
    def on_connection_state(self, cb: Callable[[str], None]) -> None: ...
    def close(self) -> None: ...


class PahoTransport:
    """Transport over paho-mqtt (1.6 or 2.x), MQTT 3.1.1, auto-reconnect via the network thread."""

    def __init__(self, url: str, *, username: str | None = None, password: str | None = None,
                 tls: dict | None = None, connect_timeout: float = 10.0):
        u = urlparse(url)
        if u.scheme not in ("mqtt", "mqtts", "tcp", "ssl") or not u.hostname:
            raise Iso21423Error(f"unsupported broker URL: {url}")
        self._secure = u.scheme in ("mqtts", "ssl")
        self._host = u.hostname
        self._port = u.port or (8883 if self._secure else 1883)
        self._username, self._password = username, password
        self._tls = tls
        self._timeout = connect_timeout
        self._client: mqtt.Client | None = None
        self._msg_cbs: list[Callable[[str, bytes], None]] = []
        self._state_cbs: list[Callable[[str], None]] = []
        self._connected = threading.Event()
        self._refused: int | None = None
        self._closing = False
        self._cond = threading.Condition()
        self._acks: dict[int, list[int]] = {}

    def _new_client(self, client_id: str, clean_session: bool) -> mqtt.Client:
        kwargs = dict(client_id=client_id, clean_session=clean_session, protocol=mqtt.MQTTv311)
        if hasattr(mqtt, "CallbackAPIVersion"):  # paho 2.x
            return mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, **kwargs)
        return mqtt.Client(**kwargs)

    def connect(self, client_id, clean_session, keepalive, username, password, will):
        c = self._client = self._new_client(client_id, clean_session)
        user = username if username is not None else self._username
        pw = password if password is not None else self._password
        if user is not None:
            c.username_pw_set(user, pw)
        if will:
            c.will_set(will.topic, will.payload, will.qos, will.retain)
        if self._secure or self._tls:
            c.tls_set(**(self._tls or {}))
        c.reconnect_delay_set(1, 30)
        c.on_connect, c.on_disconnect = self._on_connect, self._on_disconnect
        c.on_message, c.on_subscribe = self._on_message, self._on_subscribe
        c.connect_async(self._host, self._port, keepalive)
        c.loop_start()
        if not self._connected.wait(self._timeout) or self._refused is not None:
            reason = f"refused (rc={self._refused})" if self._refused is not None else "timed out"
            self._closing = True
            c.loop_stop()
            c.disconnect()
            raise Iso21423Error(f"mqtt connect {reason}: {self._host}:{self._port}")

    def _emit(self, state: str) -> None:
        for cb in self._state_cbs:
            cb(state)

    def _on_connect(self, client, userdata, flags, rc):
        if rc != 0:
            self._refused = rc
            self._connected.set()
            return
        self._connected.set()
        self._emit("connected")

    def _on_disconnect(self, client, userdata, rc):
        if not self._closing:  # close() emits "closed" itself
            self._emit("reconnecting")

    def _on_message(self, client, userdata, msg):
        for cb in self._msg_cbs:
            cb(msg.topic, bytes(msg.payload))

    def _on_subscribe(self, client, userdata, mid, granted_qos):
        with self._cond:
            self._acks[mid] = list(granted_qos)
            self._cond.notify_all()

    def _live(self) -> mqtt.Client:
        if self._closing or self._client is None:
            raise Iso21423Error("mqtt transport is not connected")
        return self._client

    def publish(self, topic, payload, qos, retain):
        info = self._live().publish(topic, payload, qos, retain)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise Iso21423Error(f"mqtt publish failed (rc={info.rc}): {topic}")

    def subscribe(self, filter, qos):
        rc, mid = self._live().subscribe(filter, qos)
        if rc != mqtt.MQTT_ERR_SUCCESS:
            raise Iso21423Error(f"mqtt subscribe failed (rc={rc}): {filter}")
        with self._cond:
            if not self._cond.wait_for(lambda: mid in self._acks, self._timeout):
                raise Iso21423Error(f"mqtt subscribe timed out: {filter}")
            granted = self._acks.pop(mid)
        return bool(granted) and all(g < 128 for g in granted)

    def unsubscribe(self, filter):
        self._live().unsubscribe(filter)

    def on_message(self, cb):
        self._msg_cbs.append(cb)

    def on_connection_state(self, cb):
        self._state_cbs.append(cb)

    def close(self):
        if self._closing or self._client is None:
            return
        self._closing = True
        self._client.disconnect()
        self._client.loop_stop()
        self._emit("closed")
