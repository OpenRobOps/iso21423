# Example Usage — IMRFM (Fleet Manager managing multiple IMRs)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`nodejs_api.md`](nodejs_api.md) and the [decision register](decision_register.md).

An IMRFM represents itself **and** manages a set of IMRs: one self `EntityHandle` plus one handle
per managed IMR, so it is always explicit which entity is acting (**D-11**). The `FleetGateway`
facade wraps this pattern with fleet ergonomics; everything below is also expressible directly on
`Iso21423Client`.

## 1. Bring-up and registering managed robots

```typescript
import { FleetGateway } from '@openrobops/iso21423/gateway';

const gateway = await FleetGateway.connect({
  transport,
  security: { selfCheck: true },              // identity-echo ACL check, default on (ND-15)
  imrfm: { id: fleetUuid, manufacturerName: 'Acme Fleet', details: {...}, accepts: [] },
});

// Each managed IMR gets its own EntityHandle (D-11); publishes go under the IMR's namespace,
// and the gateway maintains manages/managedBy identity links automatically (B.5.2.4).
const imrA = gateway.registerImr({
  id: imrAUuid, identity: { imrModel: 'Lift-9', ... },
  accepts: ['move', 'dock', 'cancelRequest'],
});
const imrB = gateway.registerImr({
  id: imrBUuid, identity: { imrModel: 'Scout-3', ... },
  accepts: ['move', 'cancelRequest'],
});
```

## 2. Publish state on behalf of managed IMRs

Each managed handle publishes into its own entity namespace — consumers can't tell whether the IMR
or its manager produced the message, which is the point of managed publication.

```typescript
fleetBackend.on('telemetry', (robotId, t) => {
  const imr = robotId === 'A' ? imrA : imrB;
  imr.publishStatus({ states: t.states });
  imr.publishOdometry({ pose: t.pose, velocity: t.twist });
  imr.publishBatteryStatus(t.battery);
});
```

## 3. Accept requests on behalf of managed IMRs

Two layers are available (**ND-11**), both on the same substrate — `RECEIVED` auto-published,
schema-invalid auto-rejected (**D-12**/**D-13**):

**Per-action handlers** (fleet-wide, with per-robot overrides):

```typescript
gateway.onRequest('move', async (move, ctx) => {
  await fleetBackend.executeMove(ctx.entity.entityUuid, move.properties, { signal: ctx.signal });
  return ctx.succeeded();
});
gateway.onRequest('move', heavyLiftMoveHandler, { imr: imrAUuid });   // override for A
```

**Whole-request escape hatch** — when a fleet scheduler must admit and drive requests as a unit:

```typescript
await imrA.acceptRequests(RequestAcceptanceFilter.all(), (req) => {
  if (!scheduler.canAdmit('A', req.request)) {
    return req.reject('REJECTED');
  }
  req.accept();                                              // → ACCEPTED
  scheduler.dispatch('A', req.request, {
    onExec:  ()      => req.updateStatus({ status: 'EXECUTING' }),
    onDone:  ()      => req.complete({ status: 'SUCCEEDED' }),
    onAbort: (why)   => req.complete({ status: 'ABORTED', reason: why }),
  });
});
```

## 4. Empty-destination dispatch (ND-12)

A request to the IMRFM with `destination: ""` means "IMRFM picks the robot" — fleet-specific by
nature, so it delegates:

```typescript
gateway.onDispatch((request, imrs) =>
  nearestIdleRobot(imrs, request)?.entityUuid ?? null);   // null → REJECTED
```

## 5. Per-entity execution policy (D-17, P-2)

```typescript
gateway.client.setDefaultExecutionPolicy(policies.parallel());  // client-wide default
imrA.setExecutionPolicy(policies.queueAfter());                 // heavy-lift robot serializes
// imrB keeps the parallel default
```

## 6. IMRFM as a requester

The IMRFM can originate requests from its own identity (`source` = the IMRFM entity, **D-09**):

```typescript
const req = await gateway.imrfm.sendRequest({
  destination: chargerUuid,
  details: [{ type: 'reserveBay', version: '1.0', properties: { bay: '3' } }],
});
req.onStatus((s) => reservations.update(s));
```

## 7. Fleet changes and shutdown

```typescript
gateway.unregisterImr(imrBUuid);   // final OFFLINE status, zero-byte-clears the robot's retained
                                   // topics, drops it from `manages`, republishes IMRFM identity
await gateway.close();             // graceful close for the IMRFM and all managed handles
```

## Notes

- One handle per managed IMR keeps `source`/identity unambiguous across the fleet (**D-11**);
  managed publication and managed acceptance are symmetric operations on that handle.
- The gateway's retained-request **janitor** (**ND-10**, default on) zero-byte-clears requests in
  its namespaces that crashed senders left retained past a grace period.
- Broker ACLs must grant the gateway credential write access to each managed robot's namespace —
  re-provisioned as the fleet changes; the startup self-check catches silent gaps (**ND-15**).
- Nothing here assumes the IMRFM is the only manager or a central controller (**D-01**).
