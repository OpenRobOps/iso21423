# ISO/FDIS 21423:2026(E) — Defects and gaps found during implementation design

**Document reviewed:** ISO/FDIS 21423:2026(en), Final Draft International Standard (voting 2026-05-25 → 2026-07-20), ISO/TC 299.
**Found during:** design of the `@openrobops/iso21423` TypeScript SDK (see `docs/superpowers/specs/2026-07-27-iso21423-sdk-design.md`).
**Purpose:** record every internal contradiction, schema/example mismatch, and underspecification that an implementer must take a position on. Items marked **[TC299]** are candidates for comments to the technical committee while the document is still an FDIS.

**SDK resolution rule** (spec §3.1): where the document contradicts itself, the Annex A JSON schema and Annex B topic details win over clause tables and prose, because they define the wire format.

---

## A. Normative contradictions (wire-format impact)

### A1. Empty `destination` is required by prose but rejected by the schema **[TC299]**

- **References:** Table C.1 (`destination` — Required: "If the field is left empty and the request message is sent to an IMRFM, the IMRFM selects the IMR to complete the request"); Annex A, requests schema, `destination` property.
- **Defect:** the schema constrains `destination` with `"format": "uuid"` and `"pattern": "^[0-9a-fA-F]{8}-…$"`, which **rejects the empty string**. The IMRFM-selects-the-robot dispatch feature described in Table C.1 (and repeated in the schema's own `description`) therefore cannot produce a schema-valid message.
- **Impact:** implementations that validate strictly will reject a message pattern the standard explicitly describes; implementations that follow the prose will emit schema-invalid messages. Direct interop break.
- **SDK position:** model `destination: Uuid | ""`; patch the bundled validation schema to `anyOf: [uuid-pattern, const ""]` and note the deviation.
- **Suggested fix:** add `""` (or a null/omitted form) to the schema, or introduce an explicit broadcast/any sentinel.

### A2. Status message field names: clause tables vs schema and examples **[TC299]**

- **References:** Table 6 (fields `id`, `operatingStates`); Table 8 (fields `id`, `states`); Annex A `entityStatus` schema (required: `entityId`, `states`); examples B.5.5.1, B.5.5.2, B.7.3 (all use `entityId` and `states`).
- **Defect:** three names for the same two fields. Table 6 says `id`/`operatingStates`; Table 8 says `id`/`states`; the normative schema and every example say `entityId`/`states`.
- **Impact:** an implementation built from Clause 6 alone will not interoperate with one built from Annex A/B.
- **SDK position:** `entityId` / `states` (schema). Ingress leniently accepts `id` with a `ValidationWarning`.
- **Suggested fix:** align Tables 6 and 8 with the schema.

### A3. Resource name `activeRequestStatus` vs `activeRequestsStatus` **[TC299]**

- **References:** B.2.2 ("The supported resources shall include: … request, activeRequestStatus"); Table B.1, B.5.4 heading, and every example `provides` list (B.5.2.1, B.6.1.x, B.7.2) use `activeRequestsStatus`.
- **Defect:** the normative resource list in B.2.2 spells the resource differently from the topic-detail clause, the resource table and all examples. Topic names are exact-match strings in MQTT.
- **SDK position:** `activeRequestsStatus` (Table B.1/B.5.4).
- **Suggested fix:** correct B.2.2.

### A4. Request state `EXECUTED` vs `EXECUTING` **[TC299]**

- **References:** Clause 9 and C.1.1.1.1 ("Received request messages can be ACCEPTED, CANCELED, EXECUTED, SUCCEEDED or ABORTED"); Table C.6 and Figure C.3 define the enum as `…EXECUTING…` and additionally include `RECEIVED` and `RECOVERY`.
- **Defect:** the prose names a state (`EXECUTED`) that does not exist in the normative enum, and omits two that do.
- **SDK position:** Table C.6 enum: `RECEIVED, ACCEPTED, EXECUTING, CANCELED, SUCCEEDED, ABORTED, RECOVERY`.
- **Suggested fix:** correct the prose in Clause 9 and C.1.1.1.1.

### A5. Timestamp decimal separator: comma vs dot **[TC299]**

- **References:** Tables 4, 6, 7, 8, C.1, C.6 write the format as `YYYY-MM-DDThh:mm:ss,fffZ` and give the example `2024-01-11T12:58:19,050Z`; Annex A declares `"format": "date-time"` with examples like `2025-04-08T10:00:00.000Z`; all Annex B/C JSON examples use the dot.
- **Defect:** ISO 8601-1 permits (and historically prefers) the comma, but JSON Schema `date-time` (RFC 3339) requires the dot. The clause tables and the schema mandate different byte sequences.
- **Impact:** a comma-emitting implementation fails everyone else's schema validation.
- **SDK position:** emit dot; parse both.
- **Suggested fix:** standardize on the dot form and update the clause tables.

### A6. Topic in B.5.3 is missing the `<entityType>` segment **[TC299]**

- **References:** B.2.1 defines the topic structure `<rootNamespace>/<entityType>/<entityUuid>/<resourceName>`; B.5.3 instructs publishing status to `/ISO_21423/v1/<entityUuid>/request/<requestUuid>/status`.
- **Defect:** the B.5.3 topic string omits `<entityType>`, contradicting the defined layout (and the B.5.4/B.5.5 headings, which include it).
- **SDK position:** always include `<entityType>`.
- **Suggested fix:** correct the topic string in B.5.3.

### A7. `knots` type: `int32` in the table, `number` in the schema

- **References:** Table A.9 (`knots` — "array of int32"); Annex A NURBS schema (`"items": {"type": "number"}, "minItems": 4`).
- **Defect:** the table restricts knot vectors to integers; the schema allows reals. NURBS knot vectors are conventionally non-decreasing reals — the integer restriction would forbid standard parameterizations (e.g. normalized [0,1] interior knots).
- **SDK position:** `number[]` (schema).
- **Suggested fix:** change Table A.9 to float32/number.

## B. Schema/example fields never defined in the clause tables

### B1. `move` target `orientation` **[TC299]**

- **References:** Table C.3 defines `location`, `toleranceRadius`, `orientationTolerance`, `arrivalTime`; the move examples in C.1.1.2.5 and C.2.4.2.1 both include a `properties.orientation` object (`yaw`/`pitch`/`roll`).
- **Defect:** the examples use a target orientation that no table defines — yet Table C.3's `orientationTolerance` ("angle range around the **expected orientation**") is meaningless without one.
- **SDK position:** accept and emit optional `orientation`.
- **Suggested fix:** add `orientation` to Table C.3.

### B2. `imrName` in schema and example, absent from Table 4

- **References:** Annex A `entityIdentity` details (property `imrName`); example B.5.2.1 (`"imrName": "user_provided"`); Table 4 (no such field).
- **SDK position:** include `imrName?` in `ImrDetails`.

### B3. `disabledCapabilities` in schema and examples, absent from Tables 6/8

- **References:** Annex A `entityStatus` schema; examples B.5.5.1, B.5.5.2, B.7.3; Tables 6 and 8 do not mention it.
- **Note:** this is a useful field (declaring temporarily unavailable capabilities) that only exists in the annexes.
- **SDK position:** include `disabledCapabilities?` in `EntityStatus`.

### B4. Odometry `orientation` absent from Table 6

- **References:** B.5.7 odometry example publishes `pose.orientation` (`yaw`/`pitch`/`roll`); Table 6 lists only `locationPoint`, `linearVelocity`, `angularVelocity` (footnote: "published as part of odometry; see B.5.7").
- **Defect:** the orientation component of pose (defined conceptually in 3.1.9) never appears in a clause table; its field-level definition exists only in the schema/example.
- **SDK position:** follow the B.5.7 message shape.

### B5. `footprint` resource missing from the B.2.2 resource list

- **References:** B.2.2 resource list omits `footprint`; Table B.1 defines it (QoS 1, retained, `entityFootprintHeight` object); the B.5.2.1 example `provides` list includes it; no B.5.x topic-detail subclause describes it.
- **Defect:** a resource that is half-specified: present in the resource table and examples, absent from the "shall include" list and the topic details.
- **SDK position:** out of v1 scope (spec §1); revisit when the standard clarifies.

## C. Gaps and underspecification

### C1. No mechanism to distribute the CCS and reference points **[TC299]**

- **References:** Clause 4 (mandates a shared CCS established from ≥3 UUID-identified reference points); Annex A defines `ccs` and `referencePoints` schema objects; A.2.1/A.2.2 say the schema is used "to communicate … common coordinate system (CCS)".
- **Defect:** no resource, topic, or message in Annex B carries the CCS or reference points. The data types exist; the transport for them does not. Every deployment must exchange the facility CCS out of band, with no standard way for a new entity to look up reference-point coordinates by UUID.
- **Impact:** the standard's central interoperability prerequisite (agreeing on coordinates) is unspecified operationally.
- **SDK position:** provide the types + Annex D calibration helpers; CCS provisioning is deployment configuration. A deployment-specific `ccs` retained resource is possible via the open resource model (B.2.2 "other resource types can be added").
- **Suggested fix:** define a retained `ccs` resource (e.g. published by a designated entity or the facility) in Annex B.

### C2. Last Will payload is a JSON fragment; `LOST_CONNECTION` and `disconnection` are unregistered **[TC299]**

- **References:** B.4 (`LastWillMessage: "states": ["LOST_CONNECTION"]`); Clause 10.3 (messages shall be JSON per ISO/IEC 21778); Annex A `operatingStates`/`states` enumeration; B.2.2/Table B.1 resource lists.
- **Defect (three parts):** (1) the specified will payload is not a valid JSON document (no enclosing object); (2) `LOST_CONNECTION` is not in the states enumeration — it only validates via the schema's catch-all `"pattern": "^[A-Z0-9_]+$"` branch; (3) `disconnection` is not listed as a resource in B.2.2 or Table B.1 — its QoS/retain profile exists only in B.4.
- **SDK position:** publish `{"states": ["LOST_CONNECTION"]}` (valid JSON object matching the `entityStatus` shape minus required fields — see below), and treat `disconnection` as a first-class resource internally.
- **Open question the standard should answer:** should the will payload include `entityId`/`timestamp` (making it a valid `entityStatus`)? A broker-stored will cannot carry a disconnect-time timestamp.

### C3. "Non-interruptible delivery quality of service" is undefined

- **References:** Clause 9: "Status updates shall be sent only if state changes; they shall not be sent periodically. To accomplish this, the message protocol shall offer a non-interruptible delivery quality of service."
- **Defect:** "non-interruptible" is not an MQTT concept and is defined nowhere. From context (change-triggered messages must not be lost) it presumably means guaranteed delivery — i.e. QoS ≥ 1, and Table B.1 assigns QoS 2 to request topics — but a normative "shall" hangs on an undefined term.
- **SDK position:** QoS levels from Table B.1, which satisfy any reasonable reading.

### C4. `requestStatus.timestamp` semantics are copied from `request`

- **References:** Table C.6 `timestamp`: "This is the timestamp when the request message was initially created by the IMRFM."
- **Defect:** the description is copy-pasted from Table C.1. For a status message it is ambiguous whether the field holds the original request's creation time or the status transition time — and it wrongly assumes the sender is an IMRFM. Consumers ordering status updates need this defined.
- **SDK position:** status emission time (each `requestStatus` is a distinct message reporting a distinct state change; `requestSequenceId` already links it to the request).

### C5. "The minimum and maximum frequency shall be set" — by whom, where?

- **References:** 6.3 and Clause 8 (both state it for status messages); Table B.1 gives suggested ranges only for streaming topics (odometry 0.5–30 Hz, localTrajectory 1–10 Hz).
- **Defect:** a normative "shall" with no defined mechanism, actor, or location for the setting. Retained/change-triggered topics have no frequency parameters at all.
- **SDK position:** rate limits configurable per resource, defaulting to Table B.1 bounds where given.

### C6. Concurrent-request handling is implementation-chosen but not advertised

- **References:** C.2.2 lists five acceptable strategies (abort-new, buffer-cancel, buffer-after, parallel, priority) and leaves the choice to the implementation.
- **Defect (gap):** a sender has no standard way to discover which strategy a receiver uses — `capabilities` advertises accepted request types but not concurrency semantics. Senders cannot know whether a second request will abort, queue, or run in parallel.
- **SDK position:** strategy is configurable per entity (spec §5.2); we document the chosen strategy in deployment docs. A `capabilities` extension would be the natural fix.

## D. Editorial

- **D1.** A.2.2 cross-references are wrong: "common coordinate system (CCS) (Clause 10)" — CCS is Clause 4; "request messages (Clause 10, Annex C)" — request messages are Clause 9.
- **D2.** Table A.9 misspells the object type: "array of NurbsControlPoiont objects" (for NurbsControlPoint, Table A.10).
- **D3.** The B.5.2.3 capabilities example is typeset as an em-dash bulleted list rather than a code block, corrupting the JSON.
- **D4.** The C.2.4.2.1 example uses action type `"charge"`, which is not among the defined actions (`move`, `pauseImr`, `resumeImr`, `cancel`, `dock`, `undock`) — permitted as a vendor extension, but the example does not say so, and `dock` with `dockActions: ["CHARGE"]` already covers the use case.
- **D5.** The `cancel` example in C.1.1.2.6.4 uses property `"id"` where Table C.4 defines `requestId` (the schema-vs-table half of this is defect A-class; noted here for the example text itself).

---

## Cross-reference

SDK-affecting items and the positions taken are summarized in the design spec, §3.1 (`docs/superpowers/specs/2026-07-27-iso21423-sdk-design.md`). This file is the complete catalogue with citations.
