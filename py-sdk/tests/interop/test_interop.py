"""Python IMR served to the TypeScript SDK as requester (subprocess `node ts_requester.mjs`)."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest

from iso21423 import Client

pytestmark = pytest.mark.interop

HERE = Path(__file__).parent
DIST = HERE.parents[2] / "ts-sdk" / "dist" / "index.js"


def run_ts(broker_url, robot_uuid, scenario):
    if not DIST.exists():
        pytest.skip("build ts-sdk first: cd ts-sdk && npm ci && npm run build")
    p = subprocess.run(["node", str(HERE / "ts_requester.mjs")], capture_output=True, text=True, timeout=40,
                       env={**os.environ, "BROKER_URL": broker_url, "TARGET_UUID": robot_uuid, "SCENARIO": scenario})
    lines = [json.loads(line) for line in p.stdout.splitlines() if line.startswith("{")]
    assert p.returncode == 0, f"{scenario}: rc={p.returncode}\n{p.stdout}\n{p.stderr}"
    return lines


@pytest.fixture
def imr(broker_url):
    uid = str(uuid.uuid4())
    c = Client.connect(broker_url, sequence_store=None)
    h = c.register_self_entity(uid, "IMR", "Acme", provides=["odometry"], accepts=["move", "cancelRequest"])
    h.publish_status(["IDLE"])
    yield h, uid
    c.close()


def test_move_succeeds(broker_url, imr):
    h, uid = imr
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    h.start_serving()
    statuses = [m["status"] for m in run_ts(broker_url, uid, "move_succeeds") if "status" in m]
    assert statuses[-1] == "SUCCEEDED"


def test_cancel(broker_url, imr):
    h, uid = imr

    def handler(a, ctx):
        ctx.cancelled.wait(15)
        return ctx.aborted("REJECTED", "cancelled")
    h.on_request("move", handler)
    h.start_serving()
    statuses = [m["status"] for m in run_ts(broker_url, uid, "cancel") if "status" in m]
    assert statuses[-1] == "CANCELED"


def test_abort_reason(broker_url, imr):
    h, uid = imr
    h.on_request("move", lambda a, ctx: ctx.aborted("GENERAL_FAILURE", "boom"))
    h.start_serving()
    out = run_ts(broker_url, uid, "abort_reason")
    assert [m for m in out if m.get("status") == "ABORTED"][-1]["reason"] == "GENERAL_FAILURE"


def test_identity_discovered(broker_url, imr):
    _, uid = imr
    ident = run_ts(broker_url, uid, "identity_discovered")[0]["identity"]
    assert ident["id"] == uid and "move" in ident["capabilities"]["accepts"]["requests"]
