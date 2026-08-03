# Example Usage — Traffic Controller (Observer / Coordinator)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`cpp_api.md`](cpp_api.md) and the [decision register](decision_register.md).

A traffic controller does not (necessarily) own robots. It **observes** the deployment, builds its own
world model from subscription callbacks (**D-18** — there is no synchronous snapshot), and may act by
sending requests to entities (e.g. pause/resume) or coordinating shared space.

## 1. Bring-up

```cpp
using namespace iso21423;

auto mqtt   = std::make_shared<my_app::PahoTransport>("tcp://broker.local:1883", "traffic-ctl");
auto client = core::Iso21423Client::create(cfg, mqtt, security).value();

// A controller may register itself as an entity so it can originate requests with a clear source.
auto controller = client->register_self_entity({
    .entity_uuid = controller_uuid,
    .entity_type = model::EntityType::TrafficController,
    .manufacturer_name = "Acme Traffic",
}).value();
```

## 2. Build a world model from subscriptions (D-18)

On subscribe, retained messages replay the last-known state of every entity; deltas then stream in.
The controller maintains its own view — the library does not keep one for you.

```cpp
DeploymentModel world;   // application-owned

auto sub_entities = client->subscribe_entities(
    model::EntityFilter::all(),
    [&](model::EntityIdentity id) { world.upsert_entity(id); });

auto sub_status = client->subscribe_resource(
    model::ResourceKind::Status, model::EntityFilter::all(),
    [&](model::ResourceEvent ev) { world.apply_status(ev); });

auto sub_odom = client->subscribe_resource(
    model::ResourceKind::Odometry,
    model::EntityFilter::of_type(model::EntityType::IMR),
    [&](model::ResourceEvent ev) { world.apply_pose(ev); });

auto sub_reqs = client->subscribe_request_status(
    model::RequestStatusFilter::all(),
    [&](model::RequestStatusSnapshot s) { world.track_request(s); });
```

## 3. React to the deployment — take action

When the controller detects a conflict (e.g. two IMRs converging on a shared corridor), it can send
requests to the relevant entities. Requests originate from the controller's own entity (**D-09**).

```cpp
world.on_conflict([&](const Conflict& c) {
  // Ask the lower-priority robot to pause.
  auto pause = controller.send_request({
      .destination = c.yielding_robot,
      .details = { { .type = "pauseImr" } },
  }).value();

  pause.stream_status([&, c](model::RequestStatusSnapshot s) {
    if (s.state == model::RequestState::Succeeded) {
      world.mark_yielded(c.yielding_robot);
      // ...later, resume once the corridor clears:
      controller.send_request({ .destination = c.yielding_robot,
                                .details = { { .type = "resumeImr" } } });
    }
  });
});
```

## 4. Coordinate factory devices (D-20)

Controllers can also observe and drive non-robot devices (doors, lifts) through the same model.

```cpp
auto sub_devices = client->subscribe_device_states(
    model::DeviceFilter::all(),
    [&](model::DeviceStateUpdate d) { world.apply_device(d); });

// Reserve a lift ahead of an approaching robot.
controller.send_request({
    .destination = lift_uuid,
    .details = { { .type = "callLift", .properties = { {"floor", "2"} } } },
});
```

## 5. Filtering options (P-3, proposed)

The observer filter model is a proposed design; builder helpers keep subscriptions expressive:

```cpp
model::EntityFilter::all();
model::EntityFilter::of_type(model::EntityType::IMR);
model::EntityFilter::entity(specific_uuid);
model::EntityFilter::any_of({ uuid_a, uuid_b });
```

## Notes

- No central-controller assumption: multiple controllers can coexist and observe the same deployment
  (**D-01**). Conflict resolution between controllers is an application concern, not a library one.
- The controller's authority is only what the deployment's security/namespace policy grants it
  (**P-4/SecurityPolicy**) — observation is broad, but the ability to send requests to an entity is
  governed by authorization.
- Everything the controller "knows" comes from subscription callbacks it processes into its own model
  (**D-18**).
