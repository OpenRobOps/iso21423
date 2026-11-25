import pytest

from iso21423.errors import Iso21423Error
from iso21423.topics import (RESOURCE_CONFIG, ResourceConfig, parse_topic, register_extension_resource,
                             request_status_topic, topic_for)


def test_topic_for():
    assert topic_for("IMR", "u1", "status") == "/ISO_21423/v1/IMR/u1/status"
    assert request_status_topic("IMR", "u1", "r1") == "/ISO_21423/v1/IMR/u1/request/r1/status"


def test_parse_topic():
    p = parse_topic("/ISO_21423/v1/IMR/u1/request/r1/status")
    assert (p.resource, p.request_uuid, p.is_request_status) == ("request", "r1", True)
    assert parse_topic("/ISO_21423/v1/IMR/u1/status/extra") is None
    assert parse_topic("/other/IMR/u1/status") is None


def test_resource_table_matches_b1():
    assert RESOURCE_CONFIG["odometry"] == ResourceConfig(0, False, 0.5, 30)
    assert RESOURCE_CONFIG["localTrajectory"] == ResourceConfig(0, False, 1, 10)
    assert RESOURCE_CONFIG["request"].qos == 2 and RESOURCE_CONFIG["request"].retain


def test_register_extension_resource():
    register_extension_resource("customData", ResourceConfig(1, False))
    register_extension_resource("customData", ResourceConfig(1, False))  # identical: no-op
    with pytest.raises(Iso21423Error):
        register_extension_resource("customData", ResourceConfig(0, False))
    with pytest.raises(Iso21423Error):
        register_extension_resource("status", ResourceConfig(1, True))
    with pytest.raises(Iso21423Error):
        register_extension_resource("bad name", ResourceConfig(1, True))
