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

import threading
from unittest.mock import MagicMock

import paho.mqtt.client as mqtt
import pytest

from iso21423.errors import Iso21423Error
from iso21423.transport import PahoTransport


def make(rc=mqtt.MQTT_ERR_SUCCESS):
    t = PahoTransport("mqtt://localhost")
    t._client = MagicMock()
    t._client.publish.return_value = MagicMock(rc=rc)
    return t


def test_publish_no_conn_is_not_an_error():
    t = make(mqtt.MQTT_ERR_NO_CONN)
    t.publish("a", "x", 1, True)
    t.publish("a", "x", 0, False)


def test_publish_other_rc_raises():
    with pytest.raises(Iso21423Error):
        make(mqtt.MQTT_ERR_QUEUE_SIZE).publish("a", "x", 1, False)


def test_subscribe_from_loop_thread_raises_clearly():
    t = make()
    errs = []

    def run():
        t._client._thread = threading.current_thread()
        try:
            t.subscribe("a/#", 1)
        except Iso21423Error as e:
            errs.append(str(e))
    th = threading.Thread(target=run); th.start(); th.join(2)
    assert errs and "callback" in errs[0]
    t._client.subscribe.assert_not_called()


def subscribed(t, filter, qos, granted):
    t._client.subscribe.return_value = (mqtt.MQTT_ERR_SUCCESS, 7)
    t._acks[7] = [granted]
    return t.subscribe(filter, qos)


def test_reconnect_without_session_resubscribes():
    t = make()
    assert subscribed(t, "a/+", 2, 2)
    assert not subscribed(t, "denied/#", 1, 0x80)
    t._client.subscribe.reset_mock()
    t._on_connect(t._client, None, {"session present": 1}, 0)
    t._client.subscribe.assert_not_called()
    t._on_connect(t._client, None, {"session present": 0}, 0)
    t._client.subscribe.assert_called_once_with("a/+", 2)


def connect_with(tls, url="mqtt://h:1883"):
    t = PahoTransport(url, tls=tls)
    c = MagicMock()
    t._new_client = lambda *a: c
    c.connect_async.side_effect = lambda *a: t._on_connect(c, None, {"session present": 1}, 0)
    t.connect("cid", True, 30, None, None, None)
    return c


def test_tls_empty_dict_enables_tls_on_mqtt_scheme():
    connect_with(tls={}).tls_set.assert_called_once_with()


def test_tls_none_leaves_tls_off_on_mqtt_scheme():
    connect_with(tls=None).tls_set.assert_not_called()


def test_inflight_pruned_and_not_tracked_while_disconnected():
    t = make()
    done = MagicMock(rc=mqtt.MQTT_ERR_SUCCESS, **{"is_published.return_value": True})
    t._client.publish.return_value = done
    t.publish("a", "x", 1, False)
    pending = MagicMock(rc=mqtt.MQTT_ERR_SUCCESS, **{"is_published.return_value": False})
    t._client.publish.return_value = pending
    t.publish("a", "x", 1, False)
    assert t._inflight == [pending]  # the published one was pruned
    t._client.publish.return_value = MagicMock(rc=mqtt.MQTT_ERR_NO_CONN)
    for _ in range(100):
        t.publish("a", "x", 1, False)
    assert t._inflight == [pending]  # close() cannot flush while disconnected: not tracked


def test_transport_has_docstring():
    assert PahoTransport.__doc__ and "paho" in PahoTransport.__doc__
