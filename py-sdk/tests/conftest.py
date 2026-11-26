"""Broker fixture: $ISO21423_TEST_BROKER, else a throwaway Docker Mosquitto, else skip."""
import os
import socket
import subprocess
import time
import uuid

import pytest

CONF = "listener 1883\nallow_anonymous true\n"


class Broker:
    def __init__(self, url, container=None):
        self.url, self.container = url, container

    def restart(self) -> None:
        """Restarts the broker container (retained messages and sessions are lost: no persistence)."""
        if not self.container:
            pytest.skip("cannot restart an external broker")
        subprocess.run(["docker", "restart", "-t", "1", self.container], check=True, capture_output=True)
        _wait_port(*self._addr())

    def _addr(self):
        host, port = self.url.removeprefix("mqtt://").split(":")
        return host, int(port)


def _wait_port(host, port, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            socket.create_connection((host, port), 1).close()
            return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"broker {host}:{port} not reachable")


@pytest.fixture(scope="session")
def broker(tmp_path_factory):
    external = os.environ.get("ISO21423_TEST_BROKER")
    if external:
        yield Broker(external)
        return
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    conf = tmp_path_factory.mktemp("mosquitto") / "mosquitto.conf"
    conf.write_text(CONF)
    conf.chmod(0o644)
    name = f"iso21423-test-{uuid.uuid4().hex[:8]}"
    try:
        try:
            subprocess.run(["docker", "run", "-d", "--rm", "--name", name, "-p", f"127.0.0.1:{port}:1883",
                            "-v", f"{conf}:/mosquitto/config/mosquitto.conf:ro", "eclipse-mosquitto:2"],
                           check=True, capture_output=True, timeout=300)
        except (OSError, subprocess.SubprocessError) as e:
            pytest.skip(f"no broker: set ISO21423_TEST_BROKER or install docker ({e})")
        _wait_port("127.0.0.1", port)
        yield Broker(f"mqtt://127.0.0.1:{port}", name)
    finally:  # also reached when `docker run` timed out after creating the container
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


@pytest.fixture
def broker_url(broker):
    return broker.url
