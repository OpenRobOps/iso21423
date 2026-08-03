# ISO 21423 interaction requirements

## Transport and topics

- The transport protocol is MQTT. Messages are JSON.
- The root namespace is `/ISO_21423/v1`.
- The general topic shape is:

```text
/ISO_21423/v1/<entityType>/<entityUuid>/<resourceName>
```

This shape supports discovery by subscribing to identity topics across entities:

```text
/ISO_21423/v1/+/+/identity
```

## MQTT session

Every MQTT session is persistent. The Last Will and Testament uses:

```text
Topic:  /ISO_21423/v1/<entityType>/<entityUuid>/disconnection
QoS:    1
Retain: true
Body:   {"states": ["LOST_CONNECTION"]}
```

Keep Alive is 60 seconds.

## Resource behavior

Resources are split between retained/change-triggered information and streaming information.

- Retained/change-triggered examples: identity, status, batteryStatus, footprint, globalPath, globalPlan, activeRequestsStatus.
- Streaming examples: odometry and localTrajectory.

See `models/interaction_model.json` for QoS and frequency metadata.

## Request protocol

A request interaction has three basic phases:

1. Sender publishes a request message to a receiver.
2. Receiver publishes requestStatus messages whenever the request state changes.
3. The final requestStatus reports one terminal state: CANCELED, SUCCEEDED, or ABORTED.

Status updates are event-driven only; they are not periodic.

For retained request topics, when the request reaches a terminal state, the retained request is cleared by publishing a zero-byte payload to the same request topic.

## Required action support

For IMRs or IMRFMs that can report location, the implementation needs support for these request actions:

- `move`
- `pauseImr`
- `resumeImr`
- `cancel` / `cancelRequest` naming needs design resolution because the draft uses both names.

For docking-capable IMRs, support for `dock` and `undock` should be considered.

## Managed entity interaction

A managing entity can publish resources for a managed entity under the managed entity's topic namespace. It can also accept requests on behalf of the managed entity. A managed entity may also accept its own requests directly.
