# Library and API surface seed

This file is intentionally non-normative. It translates ISO 21423 concepts into implementation components that can seed an architecture/design discussion.

## Core library modules

### `TopicRouter`

Responsibilities:

- build ISO 21423 MQTT topics;
- parse incoming topics;
- validate allowed resource names;
- map resource names to schema entrypoints.

Suggested methods:

```text
build_entity_topic(entity_type, entity_id, resource_name) -> topic
build_request_topic(entity_type, entity_id, request_uuid) -> topic
build_request_status_topic(entity_type, entity_id, request_uuid) -> topic
parse_topic(topic) -> TopicParts
```

### `SchemaRegistry`

Responsibilities:

- load JSON schemas;
- validate payloads by resource name;
- expose validation diagnostics for API clients.

### `EntityIdentityPublisher`

Responsibilities:

- publish identity at startup;
- republish identity when changed;
- expose entity capabilities.

### `ResourcePublisher`

Responsibilities:

- publish status, footprint, batteryStatus, odometry, trajectories, paths, and plans;
- enforce QoS/retain defaults per resource;
- reject or warn when publication behavior violates resource model.

### `RequestClient`

Responsibilities:

- create request payloads;
- publish requests to request topics;
- subscribe to requestStatus;
- correlate by request UUID, source, and sequenceId.

### `RequestExecutor`

Responsibilities:

- receive request messages;
- validate request payloads;
- accept/reject details based on capabilities;
- drive request and requestDetail finite-state machines;
- publish requestStatus on state changes;
- publish activeRequestsStatus.

### `ManagedEntityBridge`

Responsibilities:

- publish resources for managed entities under their topic namespace;
- accept requests on behalf of managed entities;
- translate to proprietary robot/fleet APIs where needed.

## API interface directions

A practical API can expose both protocol-level and domain-level operations:

```text
register_entity(identity)
publish_status(entity_id, states, disabled_capabilities=None)
publish_odometry(entity_id, pose, velocity)
send_request(destination, details, priority=100, recoveries=None)
cancel_request(source, sequence_id, action_id=None)
subscribe_entities(filter=None)
subscribe_request_status(request_uuid)
```

## Design questions to resolve early

1. Should the library expose raw schema-valid payloads, strongly typed objects, or both?
2. How strict should conformance mode be for draft inconsistencies such as `cancel` vs `cancelRequest`?
3. Should recommended fields be validation warnings instead of schema errors?
4. How should request UUID, `source`, and `sequenceId` be correlated in the public API?
5. What concurrency strategy should be the default for `RequestExecutor`?
