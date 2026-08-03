# Example Usage — Traffic Controller (Observer / Coordinator)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`nodejs_api.md`](nodejs_api.md) and the [decision register](decision_register.md).

A traffic controller does not (necessarily) own robots. It **observes** the deployment, builds its
own world model from subscription callbacks (**D-18** — there is no synchronous snapshot), and may
act by sending requests (pause/resume, device coordination). The consumer role needs no facade: it
is `Iso21423Client` + filtered subscriptions directly.

## 1. Bring-up

```typescript
import { Iso21423Client, EntityFilter } from '@openrobops/iso21423/core';

const client = await Iso21423Client.connect({ transport });

// Registering as an entity gives requests a clear source and full session behavior (recommended).
const controller = await client.registerSelfEntity({
  entityUuid: controllerUuid,
  entityType: 'TrafficController',            // open entityType (ND-05, D-20)
  manufacturerName: 'Acme Traffic',
});
// Lightweight alternative (ND-14): connect({ transport, sourceId }) — observer-plus-requests
// mode without publishing an identity.
```

## 2. Build a world model from subscriptions (D-18)

On subscribe, retained messages replay the last-known state of every entity; deltas then stream in.
The controller maintains its own view — the SDK does not keep one for it (beyond the optional
`discover()` identity catalog).

```typescript
const world = new DeploymentModel();          // application-owned

await client.subscribeEntities(EntityFilter.all(),
  (id) => world.upsertEntity(id));

await client.subscribeResource('status', EntityFilter.all(),
  (ev) => world.applyStatus(ev));

await client.subscribeResource('odometry', EntityFilter.ofType('IMR'),
  (ev) => world.applyPose(ev));               // lazy: subscribed only while listened to (ND-17)

await client.subscribeRequestStatus(RequestStatusFilter.all(),
  (s) => world.trackRequest(s));

// LWT visibility: LOST_CONNECTION events per entity
await client.subscribeResource('disconnection', EntityFilter.all(),
  (ev) => world.markLost(ev.entityUuid));
```

## 3. React to the deployment — take action

Requests originate from the controller's own handle (**D-09**):

```typescript
world.on('conflict', async (c) => {
  const pause = await controller.sendRequest({
    destination: c.yieldingRobot,
    details: [pauseImr()],
  });

  await pause.completion();                   // D-16: sugar over the status stream
  world.markYielded(c.yieldingRobot);

  world.once(`clear:${c.corridor}`, () =>
    controller.sendRequest({ destination: c.yieldingRobot, details: [resumeImr()] }));
});
```

## 4. Coordinate factory devices (D-20)

B.7 devices (doors, lifts) participate through the same open model — no dedicated device API needed
in v1:

```typescript
await client.subscribeResource('status', EntityFilter.ofType('Door'),
  (ev) => world.applyDevice(ev));

await controller.sendRequest({
  destination: liftUuid,
  details: [{ type: 'callLift', version: '1.0', properties: { floor: '2' } }],
});
```

## 5. Scoped subscriptions with `await using` (D-19)

```typescript
{
  await using odom = await client.subscribeResource(
    'odometry', EntityFilter.entity(suspectUuid), inspect);
  await investigate();
}   // Subscription disposed → MQTT unsubscribe, automatically
```

## Notes

- No central-controller assumption: multiple controllers can coexist and observe the same
  deployment (**D-01**); conflict resolution between controllers is an application concern.
- The controller's authority is whatever the deployment's broker ACLs grant it (**ND-15**) —
  observation may be broad while the right to send requests is narrow.
- Everything the controller "knows" comes from subscription callbacks processed into its own model
  (**D-18**); `client.discover()` offers only the retained-identity catalog as a convenience.
