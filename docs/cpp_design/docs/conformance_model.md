# Conformance model seed

This is a proposed implementation conformance structure, not a direct normative clause from the draft. It is intended to organize library/API design and test coverage.

## Suggested conformance groups

### 1. Payload schema conformance

Validate payloads against the JSON Schema entrypoints:

- identity
- status
- batteryStatus
- footprint
- odometry
- localTrajectory
- globalPath
- globalPlan
- request
- requestStatus
- activeRequestsStatus
- ccs
- referencePoint

### 2. Topic conformance

Check topic construction and parsing:

```text
/ISO_21423/v1/<entityType>/<entityUuid>/<resourceName>
```

Include resource-specific topics such as:

```text
request/<requestUuid>
request/<requestUuid>/status
```

### 3. Session conformance

Check persistent session setup, Last Will configuration, QoS, retain behavior, and Keep Alive.

### 4. Publication behavior conformance

Check startup/change publication for identity, change-triggered status publication, streaming constraints for odometry/localTrajectory, and retained-topic cleanup.

### 5. Request lifecycle conformance

Check requestStatus publication on state changes, terminal status behavior, activeRequestsStatus update behavior, and invalid transition rejection.

### 6. Managed entity conformance

Check that an IMRFM can publish managed IMR resources under the IMR namespace and can accept requests on behalf of managed entities.

### 7. CCS conformance

Check CCS and reference point minimum requirements: shared CCS per physical space, at least three reference points, UUID-shaped identifiers, and locationPoint references to CCS IDs.
