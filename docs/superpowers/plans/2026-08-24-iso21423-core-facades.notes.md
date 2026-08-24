# Plan 2 (core + facades) — writer notes

Plan: `docs/superpowers/plans/2026-08-24-iso21423-core-facades.md`
Sources: decision register, `nodejs_api.md`, `testing_strategy.md` §2, `oro_integration.md` §3, the
three role examples, Plan 1, and the real `ts-sdk/` build config.

## Decisions made where the docs were silent or contradictory

Each is stated in the plan's "Design decisions this plan pins" section (numbered there) so an
executor cannot silently re-decide them.

1. **Will arming vs. `connect()` ordering (P-4 vs `nodejs_api.md` §6).** MQTT 3.1.1 registers the
   Last Will at CONNECT time, but the API registers the self entity *after* `Iso21423Client.connect()`.
   I made `connect()` non-connecting: the session opens on first use, and if that first use is
   `registerSelfEntity()` the B.4 will is armed for it. Registering a self entity after some other
   operation already opened an identity-less session throws with a fix-it message.
   **Double-check this one** — it is the largest API-behavior decision in the plan. The alternatives
   were (a) requiring `self` in `connect()` options (breaks all three role examples) and (b) an
   end-and-reconnect "rebind will" path (unusable with a caller-injected `mqtt` client, which is dead
   after `end()`).
2. **Destination `entityType` for request topics.** Plan 1's defect-A6 fix put the entity type in the
   request topic; nothing in the design says how a requester learns it. Resolution order:
   explicit `RequestCommand.destinationType` → retained-identity index → `'IMR'`.
3. **Always-on retained-identity subscription**, a deliberate narrowing of ND-17 laziness (it is one
   QoS-1 retained subscription and it backs decisions 2 and 4 plus `discover()`).
4. **`NotCapableError` is provable-only** — thrown only when the destination identity is known and
   its `accepts.requests` lacks the action; unknown entities never throw. `nodejs_api.md` §7 says
   "overridable" without saying what happens when capabilities are unknown.
5. **`requestStatus` field semantics** (`source`/`sequenceId` = publisher's, `requestSequenceId` =
   the reported request's). Both fields exist in Table C.6 / `nodejs_api.md` §3 with no prose; this
   is the only self-consistent reading. Worth confirming against Annex C before 1.0.
6. **Managed entities get no LWT** (one will per MQTT connection; it belongs to the self entity).
   D-11 does not address this.
7. **Automatic `INVALID_IMR_STATE_FOR_ACTION`** needed a concrete trigger because
   `testing_strategy.md` §2 requires an integration test for it. I defined: reject when the serving
   entity's last published status contains `STOP_CATEGORY_0/1/2` or `WAIT_FOR_RESET`, except for
   `cancelRequest`/`pauseImr`/`resumeImr`. This is an SDK invention — confirm it is desirable, or
   downgrade it to an opt-in.
8. **Post-recovery terminal state.** Plan 1's Figure C.3 table (NP-2) has no `RECOVERY → SUCCEEDED`,
   so recovery after an abort always ends `ABORTED` and after a cancel always `CANCELED`; the
   recovery's own outcome only colors the reason. If NP-2 resolves the other way this rule and one
   integration case change.
9. **`StatusReason` vs `ReasonCode`.** Plan 1 implemented `ReasonCode`; `nodejs_api.md` uses
   `StatusReason`. The plan exports `StatusReason` as an alias rather than renaming Plan 1 code.
10. **`FleetGateway.registerImr()` returns a Promise.** `nodejs_api.md` §11 and `example_imrfm.md`
    show it non-awaited (`const robot: EntityHandle = gateway.registerImr(...)`), but it publishes an
    identity, republishes the IMRFM `manages` link and can run the ND-15 self-check — swallowing
    those failures would be wrong, and it delegates to `registerManagedEntity(): Promise<…>`.
    **Double-check**: this is a visible divergence from a pinned signature.
11. **`publishLocalTrajectory({ points })`.** `example_imr.md` §2 passes `{ points }`;
    `nodejs_api.md` §7 types the argument as `LocalTrajectory` (wire field `localTrajectory`). I took
    the example's ergonomic name and map it to the schema field on egress. Same pattern as
    `publishStatus(StatusUpdate)` — timestamps are optional at the API boundary everywhere.
12. **`unregister()` leaves a retained `OFFLINE` status as a tombstone** and clears every other
    retained topic. `nodejs_api.md` §7 says "final OFFLINE status, zero-byte-clears retained topics",
    which is self-contradictory if the status topic is also cleared.
13. **`queueReplace` vs `queueAfter`** return the same `AdmissionDecision`; the difference is a
    one-slot buffer expressed as an optional `bufferLimit` hint on `ExecutionPolicy`. C.2.2's exact
    semantics for "queue-replace" are not reproduced in the design docs — I read it as "the queued
    (not the executing) request is replaced".
14. **Janitor mechanism (ND-10).** Rather than probing whether a request is still retained (which
    needs a re-subscribe), the gateway simply re-issues a zero-byte retained publish after the grace
    period. Idempotent, one extra publish per terminal request. Marked with a `ponytail:` note.
15. **Session extension.** `/core` needs topic-level publish/subscribe (`request/<uuid>[/status]`
    are not plain resources), so Task 2 generalizes Plan 1's `Iso21423Session` with
    `subscribeTopic`/`publishTopic` and makes `subscribeResource` sugar over them. Plan 1's session
    tests must keep passing — that is an explicit gate in Task 2 Step 6.
16. **Duplicate-request suppression is in-memory only** (`${source}:${sequenceId}`): a restart can
    re-execute a request still retained on the broker. Marked as a known ceiling in the plan.

## Open questions for the human

- **NP-2** still blocks freezing the illegal-transition conformance cases; decisions 8 and the
  `RECEIVED → CANCELED` / `ACCEPTED → ABORTED` / `ACCEPTED → RECOVERY` edges ride on Plan 1's table.
- **NP-3**: `EntityFilter.anyOf([a, b])` in `nodejs_api.md` §6 is ambiguous about element type; the
  plan accepts `Array<Uuid | EntityFilter>`.
- **ND-15 ACL matrix**: the plan implements the self-check and `AuthorizationDenied`, but the
  "documented recommended ACL matrix per role" is not written anywhere yet — it is not assigned to
  Plan 2, 3 or 4. Someone should own it (docs task).
- **`health()` / `ClientHealth` shape** is invented (ND-18 only says "snapshot plus structured
  diagnostic/metric events"). Same for the `DiagnosticCode` enum.
- **Live-broker CI**: added as an optional, `continue-on-error`, nightly/dispatch-only job with a
  single smoke test, because `testing_strategy.md` §3 assigns the real e2e suite to Plan 3. Confirm
  that a `test/live/` directory in the SDK package now (rather than in Plan 3) is wanted.
- **Task count is 10**, slightly above the "6–10" guidance only if the packaging/CI task is split;
  Tasks 3 and 7 are the two heavy ones and could each be halved if reviewers want tighter gates.
- Repo reality check: `ts-sdk/` currently contains only exploratory files (`src/entities/imrfm-entity.ts`,
  partial `src/types/`), i.e. **Plan 1 is not actually implemented yet**. The plan is written against
  Plan 1 as specified, per instructions; executing Plan 2 before Plan 1 will not work.
