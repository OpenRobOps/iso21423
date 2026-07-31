# Request state machines

The draft defines request and requestDetail states and states that Figures C.3 and C.4 contain possible transitions. This package encodes a conservative implementation-oriented state machine from the textual status definitions, request flow, recovery descriptions, and examples. Review against the final published figure artwork before freezing conformance tests.

## Request states

States:

- RECEIVED
- ACCEPTED
- EXECUTING
- RECOVERY
- CANCELED
- SUCCEEDED
- ABORTED

Terminal states:

- CANCELED
- SUCCEEDED
- ABORTED

Suggested implementation events:

- `request_received`
- `request_accepted`
- `request_rejected`
- `execution_started`
- `cancel_requested`
- `all_details_succeeded`
- `detail_canceled_or_aborted`
- `recovery_started`
- `recovery_succeeded`
- `recovery_failed`

## requestDetail states

States:

- RECEIVED
- ACCEPTED
- EXECUTING
- CANCELED
- SUCCEEDED
- ABORTED

Terminal states:

- CANCELED
- SUCCEEDED
- ABORTED

## Design recommendation

Represent request lifecycle and detail lifecycle as explicit finite-state machines in the library, not as ad-hoc status strings. This enables:

- transition validation before publishing status;
- deterministic activeRequestsStatus generation;
- conformance tests for invalid transitions;
- well-defined recovery behavior.
