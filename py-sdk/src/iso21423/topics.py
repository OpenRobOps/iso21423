import re
from dataclasses import dataclass

from .constants import ROOT_NAMESPACE
from .errors import Iso21423Error


@dataclass(frozen=True)
class ResourceConfig:
    """Normative publish settings; min_hz/max_hz bound the publish rate where the spec constrains it."""
    qos: int
    retain: bool
    min_hz: float | None = None
    max_hz: float | None = None


# Table B.1
RESOURCE_CONFIG: dict[str, ResourceConfig] = {
    "identity": ResourceConfig(1, True),
    "status": ResourceConfig(1, True),
    "batteryStatus": ResourceConfig(0, True),
    "footprint": ResourceConfig(1, True),
    "odometry": ResourceConfig(0, False, 0.5, 30),
    "localTrajectory": ResourceConfig(0, False, 1, 10),
    "globalPath": ResourceConfig(1, True),
    "globalPlan": ResourceConfig(1, True),
    "request": ResourceConfig(2, True),
    "requestStatus": ResourceConfig(2, True),
    "activeRequestsStatus": ResourceConfig(1, True),
    "disconnection": ResourceConfig(1, True),  # B.4 LWT parameters
}
_STANDARD_RESOURCES = frozenset(RESOURCE_CONFIG)


def is_standard_resource(name: str) -> bool:
    return name in _STANDARD_RESOURCES


def register_extension_resource(name: str, config: ResourceConfig) -> None:
    """Register a deployment-defined resource. Process-wide; identical re-registration is a no-op."""
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", name):
        raise Iso21423Error(f'invalid extension resource name "{name}"')
    if name in _STANDARD_RESOURCES:
        raise Iso21423Error(f'"{name}" is a standard ISO 21423 resource and cannot be redefined')
    existing = RESOURCE_CONFIG.get(name)
    if existing is not None and existing != config:
        raise Iso21423Error(f'extension resource "{name}" is already registered with a different config')
    RESOURCE_CONFIG[name] = config


def topic_for(entity_type: str, entity_uuid: str, resource: str) -> str:
    return f"{ROOT_NAMESPACE}/{entity_type}/{entity_uuid}/{resource}"


def request_topic(entity_type: str, entity_uuid: str, request_uuid: str) -> str:
    return f"{topic_for(entity_type, entity_uuid, 'request')}/{request_uuid}"


def request_status_topic(entity_type: str, entity_uuid: str, request_uuid: str) -> str:
    return f"{request_topic(entity_type, entity_uuid, request_uuid)}/status"


@dataclass
class ParsedTopic:
    entity_type: str
    entity_uuid: str
    resource: str
    request_uuid: str | None
    is_request_status: bool


def parse_topic(topic: str) -> ParsedTopic | None:
    """Split a concrete topic, or None if outside the root namespace or of unrecognized shape."""
    prefix = ROOT_NAMESPACE + "/"
    if not topic.startswith(prefix):
        return None
    parts = topic[len(prefix):].split("/")
    if len(parts) < 3 or not all(parts[:3]):
        return None
    entity_type, entity_uuid, resource, *tail = parts
    if resource == "request" and tail:
        if len(tail) > 2 or not tail[0] or (len(tail) == 2 and tail[1] != "status"):
            return None
        return ParsedTopic(entity_type, entity_uuid, resource, tail[0], len(tail) == 2)
    if tail:
        return None
    return ParsedTopic(entity_type, entity_uuid, resource, None, False)


def disconnection_topic(entity_type: str, entity_uuid: str) -> str:
    return topic_for(entity_type, entity_uuid, "disconnection")


def topic_filter_matches(filter: str, topic: str) -> bool:
    """MQTT wildcard match (`+` one level, `#` the rest)."""
    f, t = filter.split("/"), topic.split("/")
    for i, seg in enumerate(f):
        if seg == "#":
            return True
        if i >= len(t) or (seg != "+" and seg != t[i]):
            return False
    return len(f) == len(t)
