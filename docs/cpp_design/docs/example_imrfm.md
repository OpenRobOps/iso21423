# Example Usage — IMRFM (Fleet Manager managing multiple IMRs)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`cpp_api.md`](cpp_api.md) and the [decision register](decision_register.md).

An IMRFM represents itself **and** manages a set of IMRs. It models one self-entity plus one
`EntityHandle` per managed IMR, so it is always explicit which entity is acting (**D-11**). It can
publish resources and accept requests **on behalf of** managed IMRs.

## 1. Bring-up and registering managed entities

```cpp
using namespace iso21423;

auto mqtt   = std::make_shared<my_app::PahoTransport>("tcp://broker.local:1883", "imrfm-1");
auto client = core::Iso21423Client::create(cfg, mqtt, security).value();

// The IMRFM's own entity.
auto imrfm = client->register_self_entity({
    .entity_uuid = fleet_uuid,
    .entity_type = model::EntityType::IMRFM,
    .manufacturer_name = "Acme Fleet",
}).value();

// Each managed IMR gets its own handle (D-11). Publishes happen under the IMR's namespace.
auto imr_a = client->register_managed_entity(imrfm.entity_uuid(), {
    .entity_uuid = imr_a_uuid, .entity_type = model::EntityType::IMR,
    .capabilities = { .accepts = { "move", "dock", "cancelRequest" } },
}).value();

auto imr_b = client->register_managed_entity(imrfm.entity_uuid(), {
    .entity_uuid = imr_b_uuid, .entity_type = model::EntityType::IMR,
    .capabilities = { .accepts = { "move", "cancelRequest" } },
}).value();
```

## 2. Publish state on behalf of managed IMRs

Each managed handle publishes into its own entity namespace — consumers can't tell whether the IMR or
its manager produced the message, which is the point of managed publication.

```cpp
fleet_bridge().on_robot_telemetry([&](const RobotId& id, const Telemetry& t) {
  auto& imr = (id == RobotId::A) ? imr_a : imr_b;
  imr.publish_status({ .states = t.states });
  imr.publish_odometry({ .pose = t.pose, .velocity = t.twist });
  imr.publish_battery_status({ .charge_ratio = t.battery });
});
```

## 3. Accept requests on behalf of managed IMRs

Acceptance lives on each `EntityHandle` (**D-10**). The IMRFM can serve requests for each managed IMR
independently, applying its own routing/scheduling before forwarding to the physical robot.

```cpp
auto serve_a = imr_a.accept_requests(
    model::RequestAcceptanceFilter::all(),
    [&](core::IncomingRequest req) {
      // RECEIVED auto-published; invalid auto-rejected (D-12/D-13).
      if (!fleet_scheduler().can_admit(RobotId::A, req.request())) {
        req.reject(model::StatusReason::Rejected);
        return;
      }
      req.accept();
      fleet_scheduler().dispatch(RobotId::A, req.request(), {
        .on_exec    = [&]{ req.update_status({ .state = model::RequestState::Executing }); },
        .on_done    = [&]{ req.complete({ .state = model::RequestState::Succeeded }); },
        .on_abort   = [&](auto why){ req.complete({ .state = model::RequestState::Aborted,
                                                    .reason = why }); },
      });
    });

auto serve_b = imr_b.accept_requests(/* ...same shape... */);
```

## 4. Per-entity execution policy (P-2, proposed)

An IMRFM may want different concurrency behavior per managed IMR — e.g. a heavy-lift robot serializes,
a nimble robot runs parallel. The client default is overridable per handle.

```cpp
client->set_default_execution_policy(std::make_shared<policy::ParallelDefault>());
imr_a.set_execution_policy(std::make_shared<policy::Serialized>());     // override for A
// imr_b keeps the parallel default
```

## 5. IMRFM as a requester

The IMRFM can also originate requests from its own identity (e.g. to a charging station device), with
`source` = the IMRFM entity.

```cpp
auto req = imrfm.send_request({
    .destination = charger_uuid,
    .details = { { .type = "reserveBay", .properties = { {"bay", "3"} } } },
}).value();
auto sub = req.stream_status([](auto s){ /* update reservation state */ });
```

## Notes

- One handle per managed IMR keeps `source`/identity unambiguous across the fleet (**D-11**).
- Managed publication and managed acceptance are symmetric: both are just operations on the managed
  `EntityHandle`.
- Nothing here assumes the IMRFM is the only manager or a central controller (**D-01**).
