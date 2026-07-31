# Example Usage — IMR (Intelligent Mobile Robot)

> Illustrative only — shows how the proposed API is *used*, not compile-ready code. See
> [`cpp_api.md`](cpp_api.md) and the [decision register](decision_register.md).

An IMR is a single robot: it registers one **self** entity, publishes its own resources (status,
odometry, battery, trajectories), and serves requests addressed to it.

## 1. Bring-up

```cpp
#include <iso21423/core/client.hpp>
#include <iso21423/transport/paho_transport.hpp>   // your MQTT adapter implementing TransportInterface

using namespace iso21423;

int main() {
  // The application owns the MQTT connection and injects it (D-07).
  auto mqtt = std::make_shared<my_app::PahoTransport>("tcp://broker.local:1883", "imr-42");

  model::ClientConfig cfg{ .protocol_version = "v1" };
  model::SecurityPolicy security = model::SecurityPolicy::default_namespaced();

  auto client = core::Iso21423Client::create(cfg, mqtt, security).value();

  // Register this robot as a self-entity (D-09, D-11).
  model::EntityRegistration reg{
      .entity_uuid = model::Uuid::parse("6f9d...42"),
      .entity_type = model::EntityType::IMR,
      .manufacturer_name = "Acme Robotics",
      .capabilities = {
          .provides = { model::ResourceKind::Status, model::ResourceKind::Odometry,
                        model::ResourceKind::BatteryStatus, model::ResourceKind::LocalTrajectory },
          .accepts  = { "move", "dock", "undock", "pauseImr", "resumeImr", "cancelRequest" },
      },
  };
  auto imr = client->register_self_entity(reg).value();
  // Registration publishes identity + capabilities and arms the Last Will (P-4).
```

## 2. Publish resources

```cpp
  // Change-triggered status (retained).
  imr.publish_status({ .states = { model::OperatingState::Operational },
                       .disabled_capabilities = {} });

  imr.publish_battery_status({ .charge_ratio = 0.87, .charging = false });

  // Streaming resources — the app drives the cadence within the allowed band.
  on_every_odom_tick([&](const auto& pose, const auto& twist) {
    imr.publish_odometry({ .pose = pose, .velocity = twist });   // ~0.5–30 Hz
  });

  on_every_plan_update([&](const auto& path) {
    imr.publish_local_trajectory({ .points = path });            // ~1–10 Hz
  });
```

## 3. Serve incoming requests

The library publishes **RECEIVED** automatically and auto-rejects schema-invalid requests before your
handler runs (**D-12**, **D-13**). Your handler only decides **accept** vs **reject**, then drives the
lifecycle.

```cpp
  auto serving = imr.accept_requests(
      model::RequestAcceptanceFilter::all(),
      [&](core::IncomingRequest req) {
        const auto& r = req.request();

        if (!robot_can_execute(r)) {
          req.reject(model::StatusReason::ActionNotImplemented);   // -> Aborted
          return;
        }

        req.accept();                                              // -> Accepted

        // Drive the actual robot behavior asynchronously; report progress as it happens.
        motion_stack().run(r, {
          .on_start    = [&]{ req.update_status({ .state = model::RequestState::Executing }); },
          .on_progress = [&](auto detail){ req.update_detail_status(detail); },
          .on_success  = [&]{ req.complete({ .state = model::RequestState::Succeeded }); },
          .on_failure  = [&](auto reason){ req.complete({ .state = model::RequestState::Aborted,
                                                          .reason = reason }); },
        });
      });
```

## 4. This IMR asking another entity to do something

Even an IMR can be a requester — requests always originate from an `EntityHandle` so the `source`
identity is explicit (**D-09**). `sequenceId` is assigned internally (**D-15**).

```cpp
  // e.g. ask a door (a Device entity) to open, and watch the outcome stream (D-16).
  auto req = imr.send_request({
      .destination = door_uuid,
      .details = { { .type = "openDoor", .properties = { {"doorId", "D7"} } } },
  }).value();

  auto sub = req.stream_status([](model::RequestStatusSnapshot s) {
    if (s.state == model::RequestState::Succeeded) proceed_through_door();
  });
```

## 5. Shutdown

```cpp
  serving.cancel();                 // stop serving (RAII would also do this) (D-19)
  imr.unregister();                 // clears retained identity/status
  client->shutdown(std::chrono::seconds(5));
}
```

## Notes

- Callbacks arrive on the transport's callback thread (**D-08**) — keep them non-blocking; hand heavy
  work to your own executor.
- `stream_status` is the source of truth for a request's outcome; there is no blocking future in core
  (**D-16**).
