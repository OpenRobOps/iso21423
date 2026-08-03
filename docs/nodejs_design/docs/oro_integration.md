# OpenRobOps Integration and Distribution

> Absorbed from the 2026-07-27 spec (§11). The first consumer is OpenRobOps (ORO,
> `github.com/openrobops`): a fleet management platform where a robot agent publishes protobuf over
> MQTT to a Mosquitto broker, an `ingest` service processes telemetry into MongoDB, and a Meteor
> app serves API/UI. These facts constrain the SDK build and shape the first adapter.

## 1. Compatibility requirements (hard constraints — ND-01/ND-02/ND-19)

- **Plain-JS CommonJS consumers.** ORO has no TypeScript toolchain (`ingest` is CommonJS via Babel,
  Flow annotations). The SDK ships a **dual build** — CJS + ESM via an `exports` map — plus bundled
  `.d.ts` (IntelliSense from plain JS; consumers never compile TS). No top-level await in the CJS
  entry.
- **Node ≥ 22** (ORO's runtime baseline), ES2022 output.
- **`mqtt@^5` as a peer dependency.** Both ORO services already depend on `mqtt@^5.15`; peering
  avoids a second copy. The `MqttTransport` interface also accepts a caller-constructed client.
- **No native modules**, minimal dependency tree (`ajv`, `uuid`) — ORO ships source-as-is Docker
  images where dependency weight is felt directly.
- **Apache-2.0**, matching ORO.
- **Topic coexistence:** `/ISO_21423/v1/...` (leading slash) is disjoint from ORO's agent topics
  (`ros/...`), so both traffic classes share one Mosquitto instance without collision.

## 2. ORO adapter: bridge module inside `ingest`

The adapter lives **inside the ingest service** (e.g. `oro/ingest/src/server/iso21423/`), not as a
separate service: ingest already holds the decoded real-time robot telemetry stream (the exact
input the gateway needs), plus ORO's Mongo access and settings conventions. Accepted trade-off: the
bridge's lifecycle couples to ingest; the SDK boundary keeps later extraction into a sibling
service cheap.

- The bridge implements the `FleetBackend` seam (see [deliverables.md](deliverables.md)) against
  ORO internals: robot identity/registration from Mongo robot documents; status/odometry/battery
  from ingest's telemetry pipeline (tapping the decoded protobuf stream before Mongo);
  `move`/`pause`/`resume` execution via ORO's existing command path to the robot agent.
- **CCS calibration:** facility reference points (UUID + coordinates in both the ORO map frame and
  the CCS) stored in Mongo settings; the bridge uses `/geometry` to fit the transform and converts
  all outgoing poses.
- **ACL provisioning:** ORO's broker is Mosquitto + `mosquitto-go-auth` backed by the
  `mqtt_credentials` collection. The recommended ACL matrix (**ND-15**) maps to documents there:
  the bridge credential gets write on `/ISO_21423/v1/IMRFM/<bridgeUuid>/#` plus
  `/ISO_21423/v1/IMR/<robotUuid>/#` per managed robot — and because grants are Mongo documents,
  re-provisioning as the fleet changes can be automated by the app.
- **Configuration:** enabled per deployment via ingest's `settings.json` (bridge UUID, CCS
  reference points, broker credentials); disabled by default.
- The bridge connects with its **own** MQTT session (the SDK needs its persistent-session + LWT
  semantics), reusing ORO's broker endpoint and credential conventions rather than ingest's
  existing connection.

## 3. Repository, publishing, releases (ND-19)

- **Source:** new repo **`openrobops/iso21423`** — own release cadence, matching the SDK's
  platform-agnostic positioning. CI mirrors ORO conventions: PRs build + test; `vX.Y.Z` tags
  publish.
- **Registry — phase 1: GitHub Packages** (`npm.pkg.github.com`) under `@openrobops`. Consumers add
  a scope mapping in `.npmrc`; CI installs need a `read:packages` token (known friction: required
  even for public packages).
- **Registry — phase 2 (planned): public npmjs** once the API stabilizes (target 1.0, ideally
  aligned with the standard leaving FDIS), with provenance from GitHub Actions. The package name
  doesn't change; migration is a registry switch in `.npmrc`.
- **Versioning:** semver, `0.x` while the standard is in FDIS (wire-format resolutions in
  [`nodejs_api.md` §3.1](nodejs_api.md) may resolve differently in the final IS); `1.0` when the
  published standard is confirmed. The protocol major (`/v1` topic namespace) is independent of the
  package version and pinned in `/topics`.
