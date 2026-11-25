"""Self-entity handle: publishers, request serving, lifecycle (ports ts-sdk core/entityHandle.ts)."""
import threading

from .constants import PROTOCOL_VERSION
from .executor import ActionExecutor
from .policies import DEFAULT_EXECUTION_POLICY
from .request_server import RequestServer
from .timestamps import now_timestamp
from .topics import topic_for

RETAINED_RESOURCES = (
    "identity", "batteryStatus", "globalPath", "globalPlan", "activeRequestsStatus", "disconnection",
)
_KINDS = {"identity": "entityIdentity", "status": "entityStatus", "batteryStatus": "batteryStatus",
          "odometry": "odometry", "localTrajectory": "localTrajectory", "globalPlan": "globalPlan"}


def _stamped(body: dict) -> dict:
    return {**body, "timestamp": body.get("timestamp") or now_timestamp()}


class EntityHandle:
    def __init__(self, session, sequence, entity_uuid, entity_type, manufacturer_name, details,
                 provides, accepts, execution_policy):
        self._session, self._seq = session, sequence
        self.entity_uuid, self.entity_type = entity_uuid, entity_type
        self._identity = {
            "id": entity_uuid, "timestamp": now_timestamp(), "entityType": entity_type,
            "manufacturerName": manufacturer_name, "iso21423Version": PROTOCOL_VERSION,
            "capabilities": {"provides": list(provides), "accepts": {"requests": list(accepts)}},
            "details": details or {},
        }
        self._states: list[str] = []
        self._policy = None
        self._registration_policy = execution_policy
        self._executor: ActionExecutor | None = None
        self._server: RequestServer | None = None
        self._lock = threading.Lock()

    def identity(self) -> dict:
        return self._identity

    def last_states(self) -> list[str]:
        return list(self._states)

    def _publish(self, resource: str, payload) -> None:
        self._session.publish_resource(resource, _KINDS.get(resource), payload)

    def publish_identity(self, identity: dict) -> None:
        self._identity = _stamped(identity)
        self._publish("identity", self._identity)

    def update_identity(self, **partial) -> None:
        """Shallow-merges onto the current identity and republishes with a fresh timestamp."""
        self.publish_identity({**self._identity, **partial, "timestamp": now_timestamp()})

    def publish_status(self, states: list[str]) -> None:
        self._states = list(states)
        self._publish("status", {"entityId": self.entity_uuid, "timestamp": now_timestamp(),
                                 "states": list(states)})

    def publish_battery_status(self, body: dict) -> None:
        self._publish("batteryStatus", _stamped(body))

    def publish_odometry(self, body: dict) -> None:
        self._publish("odometry", _stamped(body))

    def publish_local_trajectory(self, points: list[dict]) -> None:
        self._publish("localTrajectory", {"timestamp": now_timestamp(), "localTrajectory": points})

    def publish_global_plan(self, global_plan: list[dict]) -> None:
        self._publish("globalPlan", {"timestamp": now_timestamp(), "globalPlan": global_plan})

    def publish_extension(self, resource: str, payload) -> None:
        self._publish(resource, payload)

    def set_execution_policy(self, policy) -> None:
        self._policy = policy

    def _get_policy(self):
        return self._policy or self._registration_policy or DEFAULT_EXECUTION_POLICY

    def on_request(self, type: str, handler, override: bool = False) -> None:
        """Registers a per-action handler; the request server starts on first use."""
        with self._lock:
            if self._executor is None:
                self._executor = ActionExecutor()
                self._server = RequestServer(self._session, self, self._executor, self._seq, self._get_policy)
                self._server.start()
            executor = self._executor
        executor.register(type, handler, override)

    def stop_serving(self) -> None:
        if self._server:
            self._server.stop()

    def unregister(self) -> None:
        """Final OFFLINE status stays as the tombstone; every other retained topic is cleared."""
        self.publish_status(["OFFLINE"])
        for r in RETAINED_RESOURCES:
            self._session.clear_retained(topic_for(self.entity_type, self.entity_uuid, r))
