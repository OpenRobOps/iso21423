# ISO 21423 — Proposed C++ API

> Status: design proposal for team review. Aligns with the
> [Architecture Decision Register](decision_register.md). Decision IDs (e.g. **D-09**) are referenced
> throughout. The companion visual is
> [`diagrams/iso21423_class_diagram.mmd`](../diagrams/iso21423_class_diagram.mmd).

## Conventions

- **Language**: C++23 (**D-04**). `Result<T>` is an alias for `std::expected<T, model::Error>`.
- **ROS-agnostic / standalone** (**D-05**): standard C++ and standard libraries only.
- **Transport injected** (**D-07**): the library never owns the MQTT connection.
- **No hidden threads** (**D-08**): caller-driven; callbacks run on the transport callback thread or a
  caller-pumped dispatcher; handlers must not block.
- **`EntityHandle` is the primary actor** (**D-09**, **D-10**): requests originate only from an
  `EntityHandle`.
- **Request outcome is a stream** (**D-16**): no completion future in core.
- **`Subscription` is an RAII token** (**D-19**): destroy or `cancel()` to unsubscribe.

```cpp
namespace iso21423 {
template <class T>
using Result = std::expected<T, model::Error>;
}
```

## Namespaces

| Namespace | Contents |
|---|---|
| `iso21423::core` | `Iso21423Client`, `EntityHandle`, `RequestHandle`, `IncomingRequest`, `Subscription` |
| `iso21423::transport` | `TransportInterface`, `WillSpec`, QoS types |
| `iso21423::conformance` | `ConformanceEngine`, reports, findings |
| `iso21423::model` | value types, enums, payload structs, `Error` |

## Core enums (`iso21423::model`)

```cpp
namespace iso21423::model {

enum class EntityType { IMR, IMRFM, TrafficController, Device, Other };
enum class OwnershipMode { Self, Managed };

enum class ResourceKind {
  Identity, Capabilities, Status, BatteryStatus, Footprint,
  Odometry, LocalTrajectory, GlobalPath, GlobalPlan,
  ActiveRequestsStatus, Ccs, ReferencePoint, LocationPoint,
  Request, RequestStatus
};

// Request-level FSM (D-12, D-14).
enum class RequestState {
  Received, Accepted, Executing, Recovery, Succeeded, Canceled, Aborted
};

// Detail-level FSM.
enum class RequestDetailState {
  Received, Accepted, Executing, Succeeded, Canceled, Aborted
};

enum class StatusReason {
  Ok, ActionNotImplemented, ValidationFailed, Rejected,
  Preempted, Timeout, GeneralFailure
};

enum class Severity { Error, Warning, Info };
enum class ConformanceTier { Must, Should, May };

struct Uuid { std::array<std::uint8_t, 16> bytes; /* parse/format helpers */ };

struct Error {
  enum class Code { InvalidArgument, NotRegistered, SchemaInvalid,
                    TransportError, IllegalTransition, NotConnected, Internal };
  Code code;
  std::string message;
};

} // namespace iso21423::model
```

## Transport port (`iso21423::transport`)

Because the library does not own the connection (**D-07**), the injected transport must support Last
Will registration and connection-state callbacks (**P-4**).

```cpp
namespace iso21423::transport {

enum class Qos { AtMostOnce = 0, AtLeastOnce = 1, ExactlyOnce = 2 };

struct WillSpec {
  std::string topic;
  std::vector<std::byte> payload;
  Qos qos = Qos::AtLeastOnce;
  bool retain = true;
};

enum class ConnectionState { Connected, Disconnected, Reconnected };

using MessageCallback =
    std::function<void(std::string_view topic, std::span<const std::byte> payload)>;
using ConnectionStateCallback = std::function<void(ConnectionState)>;

class TransportInterface {
public:
  virtual ~TransportInterface() = default;
  virtual iso21423::Result<void> connect(std::optional<WillSpec> will) = 0;
  virtual iso21423::Result<void> disconnect() = 0;
  virtual iso21423::Result<void> publish(std::string_view topic,
                                         std::span<const std::byte> payload,
                                         Qos qos, bool retain) = 0;
  virtual iso21423::Result<void> subscribe(std::string_view filter, MessageCallback cb) = 0;
  virtual iso21423::Result<void> unsubscribe(std::string_view filter) = 0;
  virtual void on_connection_state(ConnectionStateCallback cb) = 0;
  virtual bool is_connected() const = 0;
};

} // namespace iso21423::transport
```

## `Subscription` (RAII, `iso21423::core`)

```cpp
namespace iso21423::core {

class Subscription {
public:
  Subscription() noexcept = default;
  Subscription(Subscription&&) noexcept;
  Subscription& operator=(Subscription&&) noexcept;
  Subscription(const Subscription&) = delete;
  Subscription& operator=(const Subscription&) = delete;
  ~Subscription();               // unsubscribes (D-19)

  void cancel();
  bool active() const;
  std::vector<std::string> topic_filters() const;
};

} // namespace iso21423::core
```

## `Iso21423Client` (`iso21423::core`)

Reduced to transport wiring, entity registration, deployment-wide observer subscriptions, and device
federation (**D-10**, **D-18**, **D-20**).

```cpp
namespace iso21423::core {

class Iso21423Client {
public:
  static iso21423::Result<std::unique_ptr<Iso21423Client>> create(
      model::ClientConfig config,
      std::shared_ptr<transport::TransportInterface> transport,
      model::SecurityPolicy security);

  // Entity registration (D-09, D-11)
  iso21423::Result<EntityHandle> register_self_entity(const model::EntityRegistration&);
  iso21423::Result<EntityHandle> register_managed_entity(
      const model::Uuid& manager_uuid, const model::ManagedEntityRegistration&);
  std::vector<EntityHandle> list_managed_entities(const model::Uuid& manager_uuid) const;

  // Deployment-wide observation (D-18): build your own world model from these.
  Subscription subscribe_entities(const model::EntityFilter&, model::IdentityHandler);
  Subscription subscribe_resource(model::ResourceKind, const model::EntityFilter&,
                                  model::ResourceHandler);
  Subscription subscribe_requests(const model::RequestFilter&, model::RequestEventHandler);
  Subscription subscribe_request_status(const model::RequestStatusFilter&,
                                        model::RequestStatusHandler);

  // Device / controller federation (D-20)
  iso21423::Result<void> publish_device_state(const model::DeviceStateUpdate&);
  Subscription subscribe_device_states(const model::DeviceFilter&, model::DeviceStateHandler);

  // Policy & diagnostics
  iso21423::Result<void> set_default_execution_policy(std::shared_ptr<model::ExecutionPolicy>);
  void set_observability(std::shared_ptr<model::ObservabilitySink>);
  model::ClientHealth health() const;

  iso21423::Result<void> shutdown(std::chrono::milliseconds timeout = std::chrono::seconds(5));
};

} // namespace iso21423::core
```

## `EntityHandle` (`iso21423::core`)

Primary actor object (**D-09**). Owns a monotonic per-source `sequenceId` (**D-15**).

```cpp
namespace iso21423::core {

class EntityHandle {
public:
  model::Uuid entity_uuid() const;
  model::EntityType entity_type() const;
  model::OwnershipMode ownership_mode() const;

  // Resource publication
  iso21423::Result<void> publish_identity(const model::EntityIdentity&);
  iso21423::Result<void> publish_status(const model::StatusUpdate&);
  iso21423::Result<void> publish_battery_status(const model::BatteryStatusUpdate&);
  iso21423::Result<void> publish_odometry(const model::OdometrySample&);
  iso21423::Result<void> publish_local_trajectory(const model::LocalTrajectorySample&);
  iso21423::Result<void> publish_global_path(const model::GlobalPathSnapshot&);
  iso21423::Result<void> publish_global_plan(const model::GlobalPlanSnapshot&);
  iso21423::Result<void> publish_footprint(const model::Footprint&);

  // Requester side (D-09): sequenceId assigned internally (D-15).
  iso21423::Result<RequestHandle> send_request(const model::RequestCommand&);

  // Executor side (D-10, D-12, D-13): library auto-publishes RECEIVED and auto-rejects
  // schema-invalid requests before the handler is invoked.
  Subscription accept_requests(const model::RequestAcceptanceFilter&,
                               model::IncomingRequestHandler);

  iso21423::Result<void> set_execution_policy(std::shared_ptr<model::ExecutionPolicy>);
  iso21423::Result<void> unregister();
};

} // namespace iso21423::core
```

## `RequestHandle` (`iso21423::core`)

Outcome is a status **stream** (**D-16**); no future in core.

```cpp
namespace iso21423::core {

class RequestHandle {
public:
  model::Uuid request_uuid() const;
  model::Uuid source_uuid() const;
  std::uint64_t sequence_id() const;
  std::optional<model::Uuid> destination() const;
  std::chrono::system_clock::time_point created_at() const;

  model::RequestStatusSnapshot latest_status() const;             // last cached status
  Subscription stream_status(model::RequestStatusHandler);        // live updates (source of truth)
  iso21423::Result<void> cancel(const model::CancelRequestCommand&);
};

} // namespace iso21423::core
```

## `IncomingRequest` (`iso21423::core`)

Handed to the `accept_requests` handler. RECEIVED is already published by the library (**D-12**);
schema-invalid requests never reach here (**D-13**).

```cpp
namespace iso21423::core {

class IncomingRequest {
public:
  model::RequestView request() const;
  model::Uuid source() const;
  std::uint64_t sequence_id() const;

  iso21423::Result<void> accept();                                    // -> Accepted
  iso21423::Result<void> reject(model::StatusReason);                 // -> Aborted
  iso21423::Result<void> update_status(const model::RequestStatusUpdate&);        // e.g. -> Executing
  iso21423::Result<void> update_detail_status(const model::RequestDetailStatusUpdate&);
  iso21423::Result<void> complete(const model::RequestTerminalUpdate&);           // -> terminal
};

} // namespace iso21423::core
```

## Conformance (`iso21423::conformance`)

Distinct from per-message validation; runs a tiered suite (**D-03**).

```cpp
namespace iso21423::conformance {

struct Finding { model::Severity severity; std::string requirement_id; std::string detail; };
struct ConformanceReport { std::vector<Finding> findings; bool passed(model::ConformanceTier) const; };

class ConformanceEngine {
public:
  ConformanceReport run(const ConformanceScope&, model::ConformanceTier) const;
  std::vector<Finding> check_payloads(const ConformanceScope&) const;
  std::vector<Finding> check_topics(const ConformanceScope&) const;
  std::vector<Finding> check_session(const ConformanceScope&) const;
  std::vector<Finding> check_publication(const ConformanceScope&) const;
  std::vector<Finding> check_lifecycle(const ConformanceScope&) const;
  std::vector<Finding> check_managed_entities(const ConformanceScope&) const;
  std::vector<Finding> check_ccs(const ConformanceScope&) const;
};

} // namespace iso21423::conformance
```

## Usage sketches

### Standalone IMR — publish status, serve requests

```cpp
auto client = iso21423::core::Iso21423Client::create(cfg, my_mqtt, security).value();
auto imr = client->register_self_entity(imr_registration).value();

imr.publish_status(status_update);

auto serving = imr.accept_requests(
    model::RequestAcceptanceFilter::all(),
    [](iso21423::core::IncomingRequest req) {
      // RECEIVED already published; schema-invalid already rejected (D-12/D-13).
      if (can_do(req.request())) {
        req.accept();                          // -> Accepted
        req.update_status(executing_update);   // -> Executing
        req.complete(succeeded_terminal);      // -> Succeeded
      } else {
        req.reject(model::StatusReason::ActionNotImplemented); // -> Aborted
      }
    });
```

### IMRFM — manage multiple IMRs (D-11)

```cpp
auto imrfm = client->register_self_entity(imrfm_registration).value();
auto imr_a = client->register_managed_entity(imrfm.entity_uuid(), imr_a_reg).value();
auto imr_b = client->register_managed_entity(imrfm.entity_uuid(), imr_b_reg).value();

imr_a.publish_status(a_status);   // published under imr_a's namespace, on its behalf
imr_b.publish_odometry(b_odom);
```

### Requester — send and monitor (D-16)

```cpp
auto handle = imr.send_request(move_command).value();   // sequenceId auto-assigned
auto sub = handle.stream_status([](model::RequestStatusSnapshot s) {
  // request-level status; s.detail_statuses available for introspection
});
```

### Traffic controller / observer — build a world model (D-18)

```cpp
auto entities = client->subscribe_entities(
    model::EntityFilter::all(), [&](model::EntityIdentity id) { world.upsert(id); });

auto statuses = client->subscribe_resource(
    model::ResourceKind::Status, model::EntityFilter::of_type(model::EntityType::IMR),
    [&](model::ResourceEvent ev) { world.apply(ev); });

auto reqs = client->subscribe_request_status(
    model::RequestStatusFilter::all(), [&](model::RequestStatusSnapshot s) { world.track(s); });
```

## Open items affecting this API (see register)

- **P-1** Schema embedding vs runtime load → affects `SchemaRegistry::create` config.
- **P-2** ExecutionPolicy scope → client default vs per-`EntityHandle` override (both shown).
- **P-3** Observer filter model → `EntityFilter` / `RequestFilter` builder shape.
- **P-4** `TransportInterface` contract → Will registration + connection-state callbacks (shown).
- **P-5** Optional transport-level correlation metadata alongside `(source, sequenceId)`.
