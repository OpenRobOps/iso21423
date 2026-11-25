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
