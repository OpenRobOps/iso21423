# Example Usage — IMR (Intelligent Mobile Robot)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`nodejs_api.md`](nodejs_api.md) and the [decision register](decision_register.md).

An IMR is a single robot: it registers one **self** entity, publishes its own resources (status,
odometry, battery, trajectories), and serves requests addressed to it. In this SDK the same
`EntityHandle` covers all three roles — publisher, executor, requester (**D-09**).

## 1. Bring-up

```typescript
import { Iso21423Client } from '@openrobops/iso21423/core';
import { createMqttTransport } from '@openrobops/iso21423/session'; // default mqtt@5 adapter

// The transport is injected (D-07); any MqttTransport implementation works.
const transport = createMqttTransport('mqtts://broker.local:8883', {
  username: 'imr-42', password: process.env.MQTT_PASSWORD,          // ND-15 pass-through
});

const client = await Iso21423Client.connect({ transport });

// Registration publishes identity + capabilities and arms the Last Will (ND-08).
const imr = await client.registerSelfEntity({
  entityUuid: '6f9d…42',
  entityType: 'IMR',
  manufacturerName: 'Acme Robotics',
  details: { imrModel: 'AR-2', imrSerialNumber: 'SN-0042', /* footprint, workingArea, … */ },
  capabilities: {
    provides: ['status', 'odometry', 'batteryStatus', 'localTrajectory'],
    accepts: ['move', 'dock', 'undock', 'pauseImr', 'resumeImr', 'cancelRequest'],  // D-02
  },
});
```

## 2. Publish resources

QoS, retain, on-change suppression, and streaming rate bounds are the SDK's job (**ND-08**) — the
app only supplies domain data.

```typescript
// Change-triggered status (retained; deep-equal guard suppresses no-op republish).
await imr.publishStatus({ states: ['MODE_AUTO', 'IDLE'] });
await imr.publishBatteryStatus({ batterySoc: 0.87, batteryChargingState: 'NOT_CHARGING' });

// Streaming resources — the app drives the cadence; the rate gate clamps to 0.5–30 Hz.
robotDriver.on('odom', (pose, twist) =>
  imr.publishOdometry({ pose, velocity: twist }));

robotDriver.on('plan', (points) =>
  imr.publishLocalTrajectory({ points }));    // 1–10 Hz
```

## 3. Serve incoming requests — high-level per-action layer (ND-11.1)

`RECEIVED` is auto-published and schema-invalid requests are auto-rejected before any handler runs
(**D-12**, **D-13**). Unknown actions are rejected with `ACTION_NOT_IMPLEMENTED`; `cancelRequest`
is resolved by the executor (fires the target's `AbortSignal`).

```typescript
imr.onRequest('move', async (move, ctx) => {
  if (!robot.canReach(move.properties.location)) {
    return ctx.aborted('INVALID_IMR_STATE_FOR_ACTION');
  }
  // The SDK has already driven RECEIVED → ACCEPTED → EXECUTING around this handler.
  for await (const p of robot.driveTo(move.properties.location, { signal: ctx.signal })) {
    ctx.progress({ distanceRemaining: p.remaining });
  }
  return ctx.succeeded();
});

imr.onRequest('pauseImr', async (_a, ctx) => { await robot.pause(); return ctx.succeeded(); });
imr.onRequest('resumeImr', async (_a, ctx) => { await robot.resume(); return ctx.succeeded(); });
```

For whole-request control (custom sequencing, admission), the low-level escape hatch is available
instead — see the [IMRFM example](example_imrfm.md) §3 (**ND-11.2**).

## 4. This IMR asking another entity to do something

Even an IMR can be a requester — requests originate from an `EntityHandle`, so `source` is always
explicit (**D-09**) and `sequenceId` is assigned and persisted internally (**D-15**, **ND-09**).

```typescript
// Ask a door (a B.7 device entity) to open, then await the outcome (D-16).
const req = await imr.sendRequest({
  destination: doorUuid,
  details: [{ type: 'openDoor', version: '1.0', properties: { doorId: 'D7' } }],
});

req.onStatus((s) => log.debug('door request', s.status));   // stream = source of truth
await req.completion();                                      // sugar: resolves on SUCCEEDED
proceedThroughDoor();
```

## 5. Shutdown

```typescript
await imr.unregister();       // final OFFLINE status, zero-byte-clears retained topics
await client.close();         // graceful end — Last Will suppressed (ND-08)
```

## Notes

- Handlers run on the event loop (**D-08**): keep them `async` and non-blocking; long robot motions
  should be awaited work, not synchronous loops.
- `completion()` exists because a Promise can't deadlock the JS event loop — a deliberate divergence
  from the C++ core, where the stream is the only outcome surface (**D-16** in the register).
- If the broker connection drops, the Last Will publishes `LOST_CONNECTION` on the robot's
  `disconnection` topic (retained); on reconnect the session republishes retained resources
  automatically (**ND-08**).
