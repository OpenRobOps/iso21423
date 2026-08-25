# ISO 21423 Core + Facades Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entity-generic `/core` layer of `@openrobops/iso21423` (`Iso21423Client`, `EntityHandle`, `RequestHandle`, `IncomingRequest`, filters, execution policies, per-action executor, discovery cache), the `FleetGateway` facade, the real `mqtt`-backed transport, a broker-free integration suite, and CI + GitHub Packages publishing.

**Architecture:** Plan 1 delivered the primitives (`types`, `topics`, `schema`, `geometry`, `requests`, `session`, `testing`). This plan adds the two layers above them: `/core` — one entity-generic actor model where every entity (self or managed) is an `EntityHandle` that publishes resources, sends requests and serves requests (**D-09**/**D-10**) — and `/gateway`, a thin IMRFM facade over `/core` (**D-11**). Dependencies stay strictly downward: `gateway` → `core` → `session` → `topics`/`schema`/`types`. Examples/e2e are Plan 3; the ORO bridge is Plan 4.

**Tech Stack:** TypeScript 5, Node ≥22, tsup (dual CJS+ESM+d.ts, subpath entries), vitest, ajv + ajv-formats, uuid, `node:crypto`, mqtt v5 (peer dependency, dynamically imported), GitHub Actions.

**Spec:** `docs/nodejs_design/docs/` — start at [`decision_register.md`](../../nodejs_design/docs/decision_register.md); API surface [`nodejs_api.md`](../../nodejs_design/docs/nodejs_api.md); tests [`testing_strategy.md`](../../nodejs_design/docs/testing_strategy.md) §2; CI/publishing [`oro_integration.md`](../../nodejs_design/docs/oro_integration.md) §3; role walkthroughs `example_imr.md`, `example_imrfm.md`, `example_traffic_controller.md`.

**Repo:** this repository (`iso21423/`, future `openrobops/iso21423`). **The npm package lives in the `ts-sdk/` subdirectory.** Every `src/…`, `test/…`, `package.json`, `tsup.config.ts` path in this plan is relative to `ts-sdk/`; every `.github/…` path is relative to the repository root. All `npm`/`npx` commands run from `ts-sdk/`.

**Assumed starting point:** Plan 1 (`2026-07-27-iso21423-sdk-foundation.md`) is fully implemented, including its design deltas — **D-02** (the cancel builder is exported as `cancelRequest()` and emits `type: 'cancelRequest'`), **NP-2** (the Plan 1 transition tables, with the four disputed transitions flagged in comments), **D-19** (`Symbol.asyncDispose` on subscriptions).

## Global Constraints

- Package name `@openrobops/iso21423`, license `Apache-2.0`, `engines.node >= 22`.
- Runtime deps ONLY: `ajv`, `ajv-formats`, `uuid`. `mqtt@^5.0.0` stays a **peerDependency** (devDependency for tests). **No new runtime dependencies in this plan.**
- `mqtt` must never enter the module graph of any entry point: the real transport adapter loads it with `await import('mqtt')` inside `connect()`. No top-level await anywhere in `src/`.
- Dual build: ESM + CJS + bundled `.d.ts` via tsup, target `es2022`; subpath exports per `nodejs_api.md` §2 (`/types`, `/schema`, `/topics`, `/geometry`, `/session`, `/core`, `/gateway`, `/testing`). The root entry re-exports everything except `/testing` (plain-JS CommonJS consumers import flat — ORO constraint, `oro_integration.md` §1).
- Topic root namespace is exactly `/ISO_21423/v1`; the protocol major is independent of the package version.
- Timestamps: always **emit** dot-decimal ISO 8601; **parse** both dot and comma (**ND-07**).
- Wire-format resolution rules are **ND-04** / `nodejs_api.md` §3.1: schema names win (`entityId`, `states`, `activeRequestsStatus`, `requestId`), `destination` accepts `""`, `knots` are `number[]`.
- Egress always emits `cancelRequest`; inbound `cancel` is accepted, normalized, and reported as a `diagnostic` event (**D-02**).
- Session rules (**ND-08**) are never bypassed: all publishing goes through `Iso21423Session`, which owns QoS/retain (Table B.1), on-change suppression, rate gating, the B.4 will, and reconnect republish. `/core` never calls `transport.publish` directly.
- Enums stay open (**ND-05**): unknown operating states, entity types and action types warn, never reject.
- Errors are typed classes from `src/errors.ts` (**ND-16**). Inbound malformed third-party messages never throw into user code; outbound validation failures throw at the call site (**ND-06**).
- Requests are addressed by `(source, sequenceId)`; `sequenceId` is SDK-owned, monotonic per `EntityHandle`, and durable across restarts (**D-15**, **ND-09**).
- Integration tests are **broker-free**: they run against `MemoryBroker`/`MemoryTransport` from `/testing` (`testing_strategy.md` §2). Real-broker work is Plan 3; this plan only adds an *optional*, non-required live-Mosquitto CI job.
- Every commit message uses conventional commits (`feat:`, `test:`, `chore:`, `ci:`, `docs:`).

## Design decisions this plan pins (docs left these open — see the review notes)

These are binding for every task below.

1. **Will arming / connect ordering.** MQTT 3.1.1 registers the Last Will at CONNECT time (**P-4**), but `nodejs_api.md` §6 registers the self entity *after* `Iso21423Client.connect()`. Resolution: `Iso21423Client.connect()` validates options and returns **without opening the MQTT connection**; the session is opened on the first operation that needs the broker. If that first operation is `registerSelfEntity()`, the session is opened with the **B.4 will for that entity**. Any other first operation opens an identity-less session (no will, **ND-14**), and a later `registerSelfEntity()` throws `Iso21423Error` telling the caller to register before subscribing/sending. `FleetGateway.connect()` registers the IMRFM as its first operation, so a gateway always has its will armed.
2. **Destination entity type.** Request topics carry the destination's `entityType` (Plan 1 defect-A6 fix), which a requester does not intrinsically know. Resolution order: `RequestCommand.destinationType` → the client's retained-identity index → `'IMR'`.
3. **Always-on identity index.** The client subscribes to `<ns>/+/+/identity` (QoS 1, retained) when its session opens, regardless of `discover()`. It backs destination-type resolution, `NotCapableError` checks, and `discover()`. This is a deliberate narrowing of **ND-17** laziness, which targets high-rate telemetry (30 Hz odometry), not one retained-identity subscription.
4. **`NotCapableError` is provable-only.** Thrown only when the destination's identity **is** known and its `capabilities.accepts.requests` lacks the action type. Unknown identity never throws. Overridable per call with `requireCapability: false`.
5. **`requestStatus` field semantics.** `source` = the entity publishing the status, `destination` = the requester, `sequenceId` = the publisher's own monotonic message counter, `requestSequenceId` = the `sequenceId` of the request being reported.
6. **Managed entities have no will.** One MQTT connection carries one will; it belongs to the self entity. A manager's `LOST_CONNECTION` is the deployment-visible signal for its managed entities (**D-11**).
7. **Automatic `INVALID_IMR_STATE_FOR_ACTION`.** The per-action executor rejects requests when the serving entity's last published status contains `STOP_CATEGORY_0`, `STOP_CATEGORY_1`, `STOP_CATEGORY_2` or `WAIT_FOR_RESET`, except for the action types `cancelRequest`, `pauseImr`, `resumeImr`.
8. **Post-recovery outcome.** Plan 1's Figure C.3 table allows `RECOVERY → {CANCELED, ABORTED}` only (**NP-2**). So recovery after an abort ends `ABORTED` (recovery outcome affects only the reason/message) and recovery after a cancel ends `CANCELED`.
9. **`StatusReason` is an alias.** Plan 1 named the wire enum type `ReasonCode`; `nodejs_api.md` calls it `StatusReason`. `/core` exports `export type StatusReason = ReasonCode` so both names work.

---

### Task 1: Real `mqtt`-backed transport adapter

**Files:**
- Create: `src/session/mqttTransport.ts`
- Modify: `src/session/index.ts`
- Test: `test/mqttTransport.test.ts`

**Interfaces:**
- Consumes: `MqttTransport`, `TransportConnectOptions`, `TransportMessage`, `ConnectionState` (Plan 1 Task 7); `BrokerUnavailable`, `Iso21423Error` (Plan 1 Task 2).
- Produces:
  - `interface MqttClientLike` — the minimal mqtt@5 surface the adapter uses: `options?: { will?: { topic?: string }; clean?: boolean }`, `connected: boolean`, `on(event: string, cb: (...args: unknown[]) => void): void`, `publishAsync(topic, payload, opts): Promise<unknown>`, `subscribeAsync(filter, opts): Promise<Array<{ topic: string; qos: number }>>`, `unsubscribeAsync(filter): Promise<unknown>`, `endAsync(force?: boolean): Promise<void>`
  - `function wrapMqttClient(client: MqttClientLike): MqttTransport` — adapts a **caller-constructed** client (**D-07**)
  - `interface MqttTransportOptions { username?: string; password?: string; tls?: Record<string, unknown>; reconnectPeriod?: number }`
  - `function createMqttTransport(url: string, opts?: MqttTransportOptions): MqttTransport` — constructs the client lazily inside `connect()` via `await import('mqtt')`

- [ ] **Step 1: Write the failing test**

```typescript
// test/mqttTransport.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  wrapMqttClient, createMqttTransport, BrokerUnavailable, Iso21423Error,
  type MqttClientLike,
} from '../src/index.js';

function fakeClient(will?: { topic: string }): MqttClientLike & {
  emit: (ev: string, ...args: unknown[]) => void;
  published: Array<{ topic: string; payload: string; qos: number; retain: boolean }>;
  subscribed: Array<{ filter: string; qos: number }>;
  unsubscribed: string[];
  ended: boolean;
  grant: number;
} {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    options: { will, clean: false },
    connected: false,
    grant: 1,
    published: [],
    subscribed: [],
    unsubscribed: [],
    ended: false,
    on(ev, cb) {
      const list = handlers.get(ev) ?? [];
      list.push(cb as (...a: unknown[]) => void);
      handlers.set(ev, list);
    },
    emit(ev, ...args) {
      for (const cb of handlers.get(ev) ?? []) cb(...args);
    },
    async publishAsync(topic: string, payload: string | Buffer, opts: { qos: number; retain: boolean }) {
      this.published.push({ topic, payload: payload.toString(), qos: opts.qos, retain: opts.retain });
      return undefined;
    },
    async subscribeAsync(filter: string, opts: { qos: number }) {
      this.subscribed.push({ filter, qos: opts.qos });
      return [{ topic: filter, qos: this.grant }];
    },
    async unsubscribeAsync(filter: string) {
      this.unsubscribed.push(filter);
      return undefined;
    },
    async endAsync() {
      this.ended = true;
    },
  } as never;
}

const CONNECT = {
  clientId: 'iso21423-IMR-u1',
  cleanSession: false,
  keepalive: 60,
  will: { topic: '/ISO_21423/v1/IMR/u1/disconnection', payload: '{}', qos: 1 as const, retain: true },
};

describe('wrapMqttClient', () => {
  it('resolves connect() when the client reports connect', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    expect(states).toEqual(['connected']);
  });

  it('rejects when the caller-constructed client has no matching will (P-4)', async () => {
    const t = wrapMqttClient(fakeClient());
    await expect(t.connect(CONNECT)).rejects.toThrow(Iso21423Error);
    await expect(t.connect(CONNECT)).rejects.toThrow(/will/i);
  });

  it('maps publish/subscribe/unsubscribe and reports SUBACK denial', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;

    await t.publish('/a/b', '{"x":1}', { qos: 2, retain: true });
    expect(c.published).toEqual([{ topic: '/a/b', payload: '{"x":1}', qos: 2, retain: true }]);

    expect(await t.subscribe('/a/+', { qos: 1 })).toEqual({ granted: true });
    c.grant = 128; // MQTT failure code
    expect(await t.subscribe('/denied/#', { qos: 1 })).toEqual({ granted: false });

    await t.unsubscribe('/a/+');
    expect(c.unsubscribed).toEqual(['/a/+']);
  });

  it('relays messages and connection-state transitions', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const seen: string[] = [];
    const states: string[] = [];
    t.onMessage((m) => seen.push(`${m.topic}|${m.qos}|${m.retain}|${m.payload.toString()}`));
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    c.emit('message', '/a/b', Buffer.from('hi'), { qos: 1, retain: true });
    c.emit('reconnect');
    c.emit('offline');
    c.emit('close');
    expect(seen).toEqual(['/a/b|1|true|hi']);
    expect(states).toEqual(['connected', 'reconnecting', 'offline', 'closed']);
  });

  it('rejects publish after end() with BrokerUnavailable', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    await t.end();
    expect(c.ended).toBe(true);
    await expect(t.publish('/a/b', 'x', { qos: 1, retain: false })).rejects.toThrow(BrokerUnavailable);
  });
});

describe('createMqttTransport', () => {
  it('does not touch the network until connect()', () => {
    expect(() => createMqttTransport('mqtt://127.0.0.1:1')).not.toThrow();
  });

  it('surfaces a refused connection as BrokerUnavailable', async () => {
    const t = createMqttTransport('mqtt://127.0.0.1:1', { reconnectPeriod: 0 });
    await expect(t.connect({ ...CONNECT })).rejects.toThrow(BrokerUnavailable);
  }, 10_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mqttTransport.test.ts`
Expected: FAIL — `wrapMqttClient` / `createMqttTransport` not exported.

- [ ] **Step 3: Implement the adapter**

```typescript
// src/session/mqttTransport.ts
import type {
  ConnectionState, MqttTransport, TransportConnectOptions, TransportMessage,
} from './transport.js';
import { BrokerUnavailable, Iso21423Error } from '../errors.js';

/** The minimal mqtt@5 surface the adapter uses — keeps `mqtt` out of the public types. */
export interface MqttClientLike {
  options?: { will?: { topic?: string }; clean?: boolean };
  connected: boolean;
  on(event: string, cb: (...args: never[]) => void): void;
  publishAsync(
    topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<unknown>;
  subscribeAsync(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<Array<{ topic: string; qos: number }>>;
  unsubscribeAsync(filter: string): Promise<unknown>;
  endAsync(force?: boolean): Promise<void>;
}

export interface MqttTransportOptions {
  username?: string;
  password?: string;
  /** TLS / socket options passed straight through to mqtt.connect (ND-15). */
  tls?: Record<string, unknown>;
  reconnectPeriod?: number;
}

class MqttAdapter implements MqttTransport {
  private client?: MqttClientLike;
  private ended = false;
  private readonly messageCbs: Array<(m: TransportMessage) => void> = [];
  private readonly stateCbs: Array<(s: ConnectionState) => void> = [];

  constructor(
    private readonly acquire: (opts: TransportConnectOptions) => Promise<MqttClientLike>,
    private readonly checkWill: boolean,
  ) {}

  async connect(opts: TransportConnectOptions): Promise<void> {
    const client = await this.acquire(opts);
    if (this.checkWill && opts.will && client.options?.will?.topic !== opts.will.topic) {
      throw new Iso21423Error(
        `caller-constructed mqtt client must be created with will { topic: "${opts.will.topic}", ` +
        `payload: '${opts.will.payload}', qos: ${opts.will.qos}, retain: ${opts.will.retain} } (P-4)`,
      );
    }
    this.client = client;
    client.on('message', ((topic: string, payload: Buffer, packet: { qos?: 0 | 1 | 2; retain?: boolean }) => {
      const msg: TransportMessage = {
        topic, payload, qos: packet?.qos ?? 0, retain: packet?.retain ?? false,
      };
      for (const cb of this.messageCbs) cb(msg);
    }) as never);
    client.on('reconnect', (() => this.emitState('reconnecting')) as never);
    client.on('offline', (() => this.emitState('offline')) as never);
    client.on('close', (() => this.emitState('closed')) as never);

    if (client.connected) {
      this.emitState('connected');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { this.emitState('connected'); resolve(); };
      const onError = (err: Error) => reject(new BrokerUnavailable(`mqtt connect failed: ${err.message}`));
      client.on('connect', onConnect as never);
      client.on('error', onError as never);
    });
  }

  async publish(
    topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    await this.live().publishAsync(topic, payload, opts);
  }

  async subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }> {
    const grants = await this.live().subscribeAsync(filter, opts);
    // MQTT 3.1.1 SUBACK: return code >= 0x80 means the broker refused the filter (ND-15).
    const granted = grants.length > 0 && grants.every((g) => g.qos < 128);
    return { granted };
  }

  async unsubscribe(filter: string): Promise<void> {
    await this.live().unsubscribeAsync(filter);
  }

  onMessage(cb: (m: TransportMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onConnectionState(cb: (s: ConnectionState) => void): void {
    this.stateCbs.push(cb);
  }

  async end(): Promise<void> {
    this.ended = true;
    if (this.client) await this.client.endAsync();
    this.emitState('closed');
  }

  private live(): MqttClientLike {
    if (this.ended || !this.client) throw new BrokerUnavailable('mqtt transport is not connected');
    return this.client;
  }

  private emitState(s: ConnectionState): void {
    for (const cb of this.stateCbs) cb(s);
  }
}

/** Adapt a caller-constructed mqtt client (D-07). Its will must match the SDK's (P-4). */
export function wrapMqttClient(client: MqttClientLike): MqttTransport {
  return new MqttAdapter(async () => client, true);
}

/**
 * Default adapter. `mqtt` is a peer dependency and is imported lazily inside connect(),
 * so importing this module never pulls mqtt into the graph (no top-level await, ND-19).
 */
export function createMqttTransport(url: string, opts: MqttTransportOptions = {}): MqttTransport {
  return new MqttAdapter(async (connectOpts) => {
    let mod: { connect: (url: string, o: Record<string, unknown>) => MqttClientLike };
    try {
      mod = (await import('mqtt')) as never;
    } catch (err) {
      throw new BrokerUnavailable(
        `the "mqtt" peer dependency is not installed: ${(err as Error).message}`,
      );
    }
    return mod.connect(url, {
      ...opts.tls,
      clientId: connectOpts.clientId,
      clean: connectOpts.cleanSession,
      keepalive: connectOpts.keepalive,
      username: connectOpts.username ?? opts.username,
      password: connectOpts.password ?? opts.password,
      reconnectPeriod: opts.reconnectPeriod,
      will: connectOpts.will,
    });
  }, false);
}
```

Add to `src/session/index.ts`:

```typescript
export * from './mqttTransport.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mqttTransport.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify `mqtt` stays out of the module graph**

Run: `node -e "const s=require('./dist/index.cjs'); console.log(typeof s.createMqttTransport, !!require.cache[require.resolve('mqtt')])"`
(Run `npm run build` first.) Expected: prints `function false`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: mqtt@5 transport adapter with lazy import and caller-client wrapping"
```

---

### Task 2: Core primitives — session topic access, subscriptions, filters, sequence durability

**Files:**
- Create: `src/core/subscription.ts`, `src/core/filters.ts`, `src/core/sequence.ts`, `src/core/resources.ts`, `src/core/index.ts`
- Modify: `src/session/session.ts` (generalize subscribe/publish to arbitrary topics), `src/index.ts`
- Test: `test/coreFilters.test.ts`, `test/coreSequence.test.ts`, `test/sessionTopics.test.ts`

**Interfaces:**
- Consumes: `Iso21423Session` (Plan 1 Task 9), `topicFilterMatches`, `parseTopic`, `RESOURCE_CONFIG`, `ROOT_NAMESPACE`, `MessageKind`, `Uuid`, `Iso21423Error`.
- Produces:
  - Session additions: `TopicMeta = { topic: string; entityType: string; entityUuid: string; resource: string; requestUuid?: string; isRequestStatus: boolean }`; `session.subscribeTopic(topicFilter: string, kind: MessageKind | null, handler: (msg: unknown, meta: TopicMeta) => void, opts?: { qos?: 0 | 1 | 2 }): Promise<SessionSubscription>`; `session.publishTopic(topic: string, kind: MessageKind | null, payload: unknown, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>`; `session.connectionState: ConnectionState`. `subscribeResource` becomes sugar over `subscribeTopic`; `SessionSubscription = { unsubscribe(): Promise<void> }`.
  - `interface Subscription extends AsyncDisposable { unsubscribe(): Promise<void>; readonly active: boolean; readonly topicFilters: readonly string[] }`
  - `function composeSubscription(topicFilters: string[], parts: Array<{ unsubscribe(): Promise<void> }>): Subscription` — idempotent `unsubscribe`, `[Symbol.asyncDispose]` alias (**D-19**)
  - `class EntityFilter { static all(); static ofType(t: string); static entity(u: Uuid); static anyOf(items: Array<Uuid | EntityFilter>); readonly selectors: readonly EntitySelector[]; topicFiltersFor(resource: string): string[]; matches(ref: { entityType: string; entityUuid: string }): boolean }` with `EntitySelector = { entityType?: string; entityUuid?: Uuid }`
  - `class RequestFilter { static all(); static toEntity(u: Uuid); static ofType(t: string); topicFilters(): string[] }` → `<ns>/<type|+>/<uuid|+>/request/+`
  - `class RequestStatusFilter { static all(); static ofEntity(u: Uuid); static ofType(t: string); topicFilters(): string[] }` → `<ns>/<type|+>/<uuid|+>/request/+/status`
  - `class RequestAcceptanceFilter { static all(); static actions(types: string[]); static fromSource(u: Uuid); matches(req: Request): boolean }`
  - `interface SequenceStore { load(entityUuid: Uuid): Promise<number | undefined>; save(entityUuid: Uuid, value: number): Promise<void> }`
  - `class FileSequenceStore implements SequenceStore { constructor(dir?: string) }` — default dir `process.env.ISO21423_STATE_DIR ?? path.join(os.homedir(), '.iso21423')`
  - `class SequenceCounter { static open(entityUuid: Uuid, store?: SequenceStore, onFallback?: (err: unknown) => void): Promise<SequenceCounter>; next(): Promise<number> }` — hi-lo reservation, block 1000; epoch-ms seed fallback (**ND-09**)
  - `type ResourceKind` and `RESOURCE_MESSAGE_KIND: Record<string, MessageKind | null>` in `src/core/resources.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/coreFilters.test.ts
import { describe, it, expect } from 'vitest';
import {
  EntityFilter, RequestFilter, RequestStatusFilter, RequestAcceptanceFilter, composeSubscription,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('EntityFilter → MQTT filters (P-3 / NP-3)', () => {
  it('all() is a two-wildcard filter', () => {
    expect(EntityFilter.all().topicFiltersFor('status'))
      .toEqual(['/ISO_21423/v1/+/+/status']);
  });
  it('ofType() pins the type level', () => {
    expect(EntityFilter.ofType('IMR').topicFiltersFor('odometry'))
      .toEqual(['/ISO_21423/v1/IMR/+/odometry']);
  });
  it('entity() pins the uuid level and leaves the type wild', () => {
    expect(EntityFilter.entity(A).topicFiltersFor('status'))
      .toEqual([`/ISO_21423/v1/+/${A}/status`]);
  });
  it('anyOf() accepts uuids and filters, deduplicating', () => {
    const f = EntityFilter.anyOf([A, EntityFilter.entity(B), EntityFilter.entity(A)]);
    expect(f.topicFiltersFor('status')).toEqual([
      `/ISO_21423/v1/+/${A}/status`,
      `/ISO_21423/v1/+/${B}/status`,
    ]);
  });
  it('matches() reproduces the selector semantics locally', () => {
    expect(EntityFilter.ofType('IMR').matches({ entityType: 'IMR', entityUuid: A })).toBe(true);
    expect(EntityFilter.ofType('IMR').matches({ entityType: 'IMRFM', entityUuid: A })).toBe(false);
    expect(EntityFilter.entity(A).matches({ entityType: 'Door', entityUuid: A })).toBe(true);
  });
});

describe('request filters', () => {
  it('RequestFilter targets request topics one level below', () => {
    expect(RequestFilter.all().topicFilters()).toEqual(['/ISO_21423/v1/+/+/request/+']);
    expect(RequestFilter.toEntity(A).topicFilters()).toEqual([`/ISO_21423/v1/+/${A}/request/+`]);
  });
  it('RequestStatusFilter targets the status leaf', () => {
    expect(RequestStatusFilter.all().topicFilters()).toEqual(['/ISO_21423/v1/+/+/request/+/status']);
    expect(RequestStatusFilter.ofType('IMR').topicFilters())
      .toEqual(['/ISO_21423/v1/IMR/+/request/+/status']);
  });
  it('RequestAcceptanceFilter is a local predicate', () => {
    const req = {
      destination: B, source: A, sequenceId: 1, timestamp: '2025-04-08T12:34:56.789Z',
      details: [{ type: 'move', version: '1.0' }],
    };
    expect(RequestAcceptanceFilter.all().matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.actions(['move']).matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.actions(['dock']).matches(req)).toBe(false);
    expect(RequestAcceptanceFilter.fromSource(A).matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.fromSource(B).matches(req)).toBe(false);
  });
});

describe('composeSubscription (D-19)', () => {
  it('unsubscribes every part once and supports await using', async () => {
    let calls = 0;
    const part = { unsubscribe: async () => { calls += 1; } };
    const sub = composeSubscription(['/a/+'], [part, part]);
    expect(sub.active).toBe(true);
    expect(sub.topicFilters).toEqual(['/a/+']);
    await sub.unsubscribe();
    await sub.unsubscribe();
    expect(calls).toBe(2);
    expect(sub.active).toBe(false);

    calls = 0;
    {
      await using scoped = composeSubscription(['/b/+'], [part]);
      expect(scoped.active).toBe(true);
    }
    expect(calls).toBe(1);
  });
});
```

```typescript
// test/coreSequence.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSequenceStore, SequenceCounter, type SequenceStore } from '../src/index.js';

const U = '11111111-1111-4111-8111-111111111111';

describe('SequenceCounter (D-15, ND-09)', () => {
  it('is monotonic from 1 on a fresh store', async () => {
    const store = new Map<string, number>();
    const mem: SequenceStore = {
      load: async (k) => store.get(k),
      save: async (k, v) => void store.set(k, v),
    };
    const c = await SequenceCounter.open(U, mem);
    expect([await c.next(), await c.next(), await c.next()]).toEqual([1, 2, 3]);
  });

  it('never reuses ids after a restart (reservation block persisted)', async () => {
    const store = new Map<string, number>();
    const mem: SequenceStore = {
      load: async (k) => store.get(k),
      save: async (k, v) => void store.set(k, v),
    };
    const first = await SequenceCounter.open(U, mem);
    const used = [await first.next(), await first.next()];
    const second = await SequenceCounter.open(U, mem);
    const after = await second.next();
    expect(after).toBeGreaterThan(Math.max(...used));
  });

  it('falls back to an epoch-millisecond seed when the store fails (ND-09)', async () => {
    const broken: SequenceStore = {
      load: async () => { throw new Error('no fs'); },
      save: async () => { throw new Error('no fs'); },
    };
    const errors: unknown[] = [];
    const c = await SequenceCounter.open(U, broken, (e) => errors.push(e));
    const n = await c.next();
    expect(n).toBeGreaterThan(1_700_000_000_000);
    expect(errors).toHaveLength(1);
  });
});

describe('FileSequenceStore', () => {
  it('round-trips per-entity seeds through a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso21423-seq-'));
    const store = new FileSequenceStore(dir);
    expect(await store.load(U)).toBeUndefined();
    await store.save(U, 4242);
    expect(await store.load(U)).toBe(4242);
    const raw = JSON.parse(await readFile(join(dir, 'sequence.json'), 'utf8')) as Record<string, number>;
    expect(raw[U]).toBe(4242);
  });
});
```

```typescript
// test/sessionTopics.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Iso21423Session, AuthorizationDenied } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';
const REQ_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/request/${REQ}`;
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

const request = {
  destination: IMR.entityUuid, source: '42177726-26f7-4f5c-b735-a12a427bb96d',
  sequenceId: 7, timestamp: '2025-04-08T12:34:56.789Z',
  details: [{ type: 'move', version: '1.0', properties: {} }],
};

describe('session.publishTopic / subscribeTopic', () => {
  it('publishes validated payloads to an arbitrary topic with explicit qos/retain', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    await s.publishTopic(REQ_TOPIC, 'request', request, { qos: 2, retain: true });
    const [msg] = broker.messagesOn(REQ_TOPIC);
    expect(msg!.qos).toBe(2);
    expect(msg!.retain).toBe(true);
    await expect(s.publishTopic(REQ_TOPIC, 'request', { destination: 5 }, { qos: 2, retain: true }))
      .rejects.toThrow(/not ISO 21423 conformant/);
  });

  it('delivers to wildcard topic subscriptions with parsed meta', async () => {
    const broker = new MemoryBroker();
    const pub = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const sub = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const seen: Array<{ requestUuid?: string; resource: string; entityUuid: string }> = [];
    await sub.subscribeTopic('/ISO_21423/v1/+/+/request/+', 'request', (_m, meta) => seen.push(meta));
    await pub.publishTopic(REQ_TOPIC, 'request', request, { qos: 2, retain: true });
    await flush();
    expect(seen).toEqual([
      { topic: REQ_TOPIC, entityType: 'IMR', entityUuid: IMR.entityUuid, resource: 'request',
        requestUuid: REQ, isRequestStatus: false },
    ]);
  });

  it('passes raw text through when kind is null (zero-byte clears included)', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const seen: unknown[] = [];
    await s.subscribeTopic('/ISO_21423/v1/+/+/identity', null, (m) => seen.push(m));
    await s.publishRaw(`/ISO_21423/v1/IMR/${IMR.entityUuid}/identity`, '', { qos: 1, retain: true });
    await flush();
    expect(seen).toEqual(['']);
  });

  it('throws AuthorizationDenied on SUBACK denial', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/+/+/request/+');
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    await expect(s.subscribeTopic('/ISO_21423/v1/+/+/request/+', 'request', () => {}))
      .rejects.toThrow(AuthorizationDenied);
  });

  it('unsubscribes from the broker only when the last listener on a filter goes away (ND-17)', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const a = await s.subscribeTopic('/ISO_21423/v1/+/+/status', 'entityStatus', () => {});
    const b = await s.subscribeTopic('/ISO_21423/v1/+/+/status', 'entityStatus', () => {});
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(1);
    await a.unsubscribe();
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(1);
    await b.unsubscribe();
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coreFilters.test.ts test/coreSequence.test.ts test/sessionTopics.test.ts`
Expected: FAIL — new exports and session methods missing; `broker.subscriptions()` missing.

- [ ] **Step 3: Extend `MemoryBroker`/`MemoryTransport` with subscription introspection**

In `src/testing/memoryTransport.ts`:
- give `MemoryTransport` a public `clientId = ''` set in `connect()` from `opts.clientId`, and a public `subscriptions(): ReadonlyArray<{ filter: string; qos: 0 | 1 | 2 }>` returning a copy of its `subs`;
- deduplicate: `subscribe()` does not push a second entry for a `(filter, qos)` pair it already holds (mirrors a real broker, where re-subscribing the same filter replaces the entry);
- add to `MemoryBroker`:

```typescript
  /** Every live subscription across all clients — for lazy-subscribe and QoS assertions. */
  subscriptions(): Array<{ clientId: string; filter: string; qos: 0 | 1 | 2 }> {
    return [...this.clients].flatMap((c) =>
      c.subscriptions().map((s) => ({ clientId: c.clientId, ...s })));
  }
```

- [ ] **Step 4: Generalize the session to arbitrary topics**

In `src/session/session.ts`:
- export `interface TopicMeta { topic: string; entityType: string; entityUuid: string; resource: string; requestUuid?: string; isRequestStatus: boolean }` and rename the subscription record to `TopicSub { filter: string; kind: MessageKind | null; handler: (msg: unknown, meta: TopicMeta) => void }` (drop the `resource` field);
- replace `dispatch`'s `parsed.resource !== sub.resource` test with `topicFilterMatches(sub.filter, topic)`, and build `meta` from `parseTopic` (`resource`, `requestUuid`, `isRequestStatus` included);
- keep the empty-payload path only for `kind === null` subscriptions: an empty payload with a non-null `kind` is ignored silently (it is a retained-clear, not a malformed message — no `validation-warning`);
- add the new methods and a public connection-state getter:

```typescript
  /** Live subscription count per filter drives the lazy unsubscribe (ND-17). */
  async subscribeTopic(
    topicFilter: string,
    kind: MessageKind | null,
    handler: (msg: unknown, meta: TopicMeta) => void,
    opts: { qos?: 0 | 1 | 2 } = {},
  ): Promise<SessionSubscription> {
    const qos = opts.qos ?? this.qosForFilter(topicFilter);
    if (!this.topicSubs.some((s) => s.filter === topicFilter)) {
      const { granted } = await this.transport.subscribe(topicFilter, { qos });
      if (!granted) {
        throw new AuthorizationDenied(`subscription denied by broker: ${topicFilter}`, topicFilter);
      }
    }
    const sub: TopicSub = { filter: topicFilter, kind, handler };
    this.topicSubs.push(sub);
    this.subscribedFilters.set(topicFilter, qos);
    return {
      unsubscribe: async () => {
        this.topicSubs = this.topicSubs.filter((s) => s !== sub);
        if (!this.topicSubs.some((s) => s.filter === topicFilter)) {
          this.subscribedFilters.delete(topicFilter);
          await this.transport.unsubscribe(topicFilter);
        }
      },
    };
  }

  /** Publish to an exact topic (request / requestStatus topics are not plain resources). */
  async publishTopic(
    topic: string,
    kind: MessageKind | null,
    payload: unknown,
    opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    if (kind && this.validateOutbound) assertValid(kind, payload);
    await this.transport.publish(topic, JSON.stringify(payload), opts);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }
```

Notes for the implementer:
- `qosForFilter(filter)` looks the last non-wildcard path segment up in `RESOURCE_CONFIG` (`request/+` and `request/+/status` map to the `request` / `requestStatus` entries — QoS 2), defaulting to QoS 1 when unknown.
- `publishTopic` deliberately does **not** join the on-change guard or the reconnect-republish set: retained request messages are broker-persisted one-shots that the sender clears at terminal state (**ND-10**), and re-publishing them on reconnect would resurrect completed requests.
- `subscribeResource(filter, resource, kind, handler)` keeps its Plan 1 signature and becomes a one-line wrapper that builds `<ns>/<type|+>/<uuid|+>/<resource>` and calls `subscribeTopic`.
- track `private state: ConnectionState = 'closed'` in `handleConnectionState`.

- [ ] **Step 5: Implement the core primitive modules**

```typescript
// src/core/resources.ts
import type { MessageKind } from '../schema/validators.js';

export type ResourceKind =
  | 'identity' | 'status' | 'batteryStatus' | 'odometry' | 'localTrajectory'
  | 'globalPath' | 'globalPlan' | 'activeRequestsStatus' | 'disconnection'
  | (string & {});

/** Resource name → schema message kind; `null` means "no schema, raw text" (ND-04). */
export const RESOURCE_MESSAGE_KIND: Record<string, MessageKind | null> = {
  identity: 'entityIdentity',
  status: 'entityStatus',
  batteryStatus: 'batteryStatus',
  odometry: 'odometry',
  localTrajectory: 'localTrajectory',
  globalPath: 'globalPath',
  globalPlan: 'globalPlan',
  request: 'request',
  requestStatus: 'requestStatus',
  activeRequestsStatus: 'requestStatusArray',
  disconnection: null,
  footprint: null,
};

export function messageKindFor(resource: string): MessageKind | null {
  return RESOURCE_MESSAGE_KIND[resource] ?? null;
}
```

```typescript
// src/core/subscription.ts

/** Lifetime token: `unsubscribe()` or `await using` (D-19). */
export interface Subscription extends AsyncDisposable {
  unsubscribe(): Promise<void>;
  readonly active: boolean;
  readonly topicFilters: readonly string[];
}

/** Bundle N session subscriptions (one per compiled MQTT filter) into one token. */
export function composeSubscription(
  topicFilters: string[],
  parts: Array<{ unsubscribe(): Promise<void> }>,
): Subscription {
  let live = true;
  const sub: Subscription = {
    topicFilters: Object.freeze([...topicFilters]),
    get active() { return live; },
    async unsubscribe() {
      if (!live) return;              // idempotent
      live = false;
      await Promise.all(parts.map((p) => p.unsubscribe()));
    },
    async [Symbol.asyncDispose]() {
      await sub.unsubscribe();
    },
  };
  return sub;
}
```

```typescript
// src/core/filters.ts
import { ROOT_NAMESPACE } from '../types/constants.js';
import type { Uuid } from '../types/common.js';
import type { Request } from '../types/requests.js';

export interface EntitySelector { entityType?: string; entityUuid?: Uuid }

const level = (v?: string) => v ?? '+';

/** Structured observer filter compiling to MQTT wildcard subscriptions (P-3, NP-3). */
export class EntityFilter {
  private constructor(readonly selectors: readonly EntitySelector[]) {}

  static all(): EntityFilter { return new EntityFilter([{}]); }
  static ofType(entityType: string): EntityFilter { return new EntityFilter([{ entityType }]); }
  static entity(entityUuid: Uuid): EntityFilter { return new EntityFilter([{ entityUuid }]); }

  /** Accepts uuids or nested filters; duplicate selectors collapse. */
  static anyOf(items: Array<Uuid | EntityFilter>): EntityFilter {
    const selectors: EntitySelector[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const part = typeof item === 'string' ? EntityFilter.entity(item) : item;
      for (const s of part.selectors) {
        const key = `${s.entityType ?? '+'}/${s.entityUuid ?? '+'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selectors.push(s);
      }
    }
    return new EntityFilter(selectors);
  }

  topicFiltersFor(resource: string): string[] {
    return this.selectors.map(
      (s) => `${ROOT_NAMESPACE}/${level(s.entityType)}/${level(s.entityUuid)}/${resource}`);
  }

  matches(ref: { entityType: string; entityUuid: string }): boolean {
    return this.selectors.some((s) =>
      (s.entityType === undefined || s.entityType === ref.entityType)
      && (s.entityUuid === undefined || s.entityUuid === ref.entityUuid));
  }
}

class TopicSetFilter {
  protected constructor(
    protected readonly selectors: readonly EntitySelector[],
    private readonly suffix: string,
  ) {}
  topicFilters(): string[] {
    return this.selectors.map(
      (s) => `${ROOT_NAMESPACE}/${level(s.entityType)}/${level(s.entityUuid)}/${this.suffix}`);
  }
}

/** Observe requests addressed to entities (`…/request/<uuid>`). */
export class RequestFilter extends TopicSetFilter {
  static all(): RequestFilter { return new RequestFilter([{}], 'request/+'); }
  static toEntity(entityUuid: Uuid): RequestFilter {
    return new RequestFilter([{ entityUuid }], 'request/+');
  }
  static ofType(entityType: string): RequestFilter {
    return new RequestFilter([{ entityType }], 'request/+');
  }
}

/** Observe request status streams (`…/request/<uuid>/status`). */
export class RequestStatusFilter extends TopicSetFilter {
  static all(): RequestStatusFilter { return new RequestStatusFilter([{}], 'request/+/status'); }
  static ofEntity(entityUuid: Uuid): RequestStatusFilter {
    return new RequestStatusFilter([{ entityUuid }], 'request/+/status');
  }
  static ofType(entityType: string): RequestStatusFilter {
    return new RequestStatusFilter([{ entityType }], 'request/+/status');
  }
}

/** Local predicate over requests arriving on an entity's own request topic (ND-11.2). */
export class RequestAcceptanceFilter {
  private constructor(private readonly predicate: (req: Request) => boolean) {}
  static all(): RequestAcceptanceFilter { return new RequestAcceptanceFilter(() => true); }
  static actions(types: string[]): RequestAcceptanceFilter {
    const wanted = new Set(types);
    return new RequestAcceptanceFilter((req) => req.details.some((d) => wanted.has(d.type)));
  }
  static fromSource(source: Uuid): RequestAcceptanceFilter {
    return new RequestAcceptanceFilter((req) => req.source === source);
  }
  matches(req: Request): boolean { return this.predicate(req); }
}
```

```typescript
// src/core/sequence.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Uuid } from '../types/common.js';

/** Pluggable persistence for the per-entity sequenceId seed (ND-09). */
export interface SequenceStore {
  load(entityUuid: Uuid): Promise<number | undefined>;
  save(entityUuid: Uuid, value: number): Promise<void>;
}

export function defaultStateDir(): string {
  return process.env.ISO21423_STATE_DIR ?? join(homedir(), '.iso21423');
}

/** Default store: one JSON map per state directory, written atomically. */
export class FileSequenceStore implements SequenceStore {
  private readonly file: string;
  constructor(private readonly dir: string = defaultStateDir()) {
    this.file = join(this.dir, 'sequence.json');
  }

  private async read(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }

  async load(entityUuid: Uuid): Promise<number | undefined> {
    return (await this.read())[entityUuid];
  }

  async save(entityUuid: Uuid, value: number): Promise<void> {
    const all = await this.read();
    all[entityUuid] = value;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all), 'utf8');
    await rename(tmp, this.file);
  }
}

const BLOCK = 1000;

/**
 * Monotonic sequenceId source owned by an EntityHandle (D-15).
 * Reserves BLOCK ids per persisted write, so a crash can waste ids but never reuse them.
 */
export class SequenceCounter {
  private constructor(
    private readonly entityUuid: Uuid,
    private readonly store: SequenceStore | undefined,
    private counter: number,
    private reservedThrough: number,
  ) {}

  static async open(
    entityUuid: Uuid,
    store?: SequenceStore,
    onFallback?: (err: unknown) => void,
  ): Promise<SequenceCounter> {
    if (!store) return new SequenceCounter(entityUuid, undefined, 0, Number.MAX_SAFE_INTEGER);
    try {
      const seed = (await store.load(entityUuid)) ?? 0;
      await store.save(entityUuid, seed + BLOCK);
      return new SequenceCounter(entityUuid, store, seed, seed + BLOCK);
    } catch (err) {
      // Persistence unavailable: seed from epoch milliseconds so restarts cannot collide
      // with requests still retained on the broker (ND-09).
      onFallback?.(err);
      return new SequenceCounter(entityUuid, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
    }
  }

  async next(): Promise<number> {
    this.counter += 1;
    if (this.counter > this.reservedThrough && this.store) {
      this.reservedThrough = this.counter + BLOCK;
      await this.store.save(this.entityUuid, this.reservedThrough);
    }
    return this.counter;
  }
}
```

```typescript
// src/core/index.ts
export * from './resources.js';
export * from './subscription.js';
export * from './filters.js';
export * from './sequence.js';
```

Add to `src/index.ts`:

```typescript
export * from './core/index.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/coreFilters.test.ts test/coreSequence.test.ts test/sessionTopics.test.ts && npm test && npm run typecheck`
Expected: PASS, including the whole Plan 1 suite (the session refactor must not regress it).

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat: core subscription tokens, entity/request filters, durable sequence ids"
```

---

### Task 3: `Iso21423Client` + `EntityHandle` — registration, publication, observation, discovery

**Files:**
- Create: `src/core/types.ts`, `src/core/client.ts`, `src/core/entityHandle.ts`, `src/core/entityCache.ts`
- Modify: `src/core/index.ts`
- Test: `test/coreClient.test.ts`, `test/coreEntityCache.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 plus `Iso21423Session`, `RESOURCE_CONFIG`, `topicFor`, `disconnectionTopic`, `nowTimestamp`, all `types/`.
- Produces:
  - `src/core/types.ts`:
    - `type StatusReason = ReasonCode` (alias, decision 9)
    - `type WithOptionalTimestamp<T> = Omit<T, 'timestamp'> & { timestamp?: Date | IsoTimestamp }`
    - `function toTimestamp(t?: Date | IsoTimestamp): IsoTimestamp`
    - `interface EntityRegistration { entityUuid: Uuid; entityType: string; manufacturerName: string; iso21423Version?: string; details?: Record<string, unknown>; capabilities?: { provides?: string[]; accepts?: string[] }; executionPolicy?: ExecutionPolicy }`
    - `type ManagedEntityRegistration = EntityRegistration` (with `entityType` defaulting to `'IMR'`)
    - `interface StatusUpdate { states: OperatingState[]; disabledCapabilities?: Capabilities; timestamp?: Date | IsoTimestamp }`
    - `interface LocalTrajectoryUpdate { points: LocationPointStamped[]; timestamp?: Date | IsoTimestamp }`
    - `interface ResourceEvent<T = unknown> { entityType: string; entityUuid: Uuid; kind: ResourceKind; topic: string; message: T }`
    - `interface RequestEvent { entityType: string; entityUuid: Uuid; requestUuid: Uuid; request: Request; topic: string }`
    - `interface SecurityOptions { username?: string; password?: string; tls?: Record<string, unknown>; selfCheck?: boolean; selfCheckTimeoutMs?: number }`
    - `type DiagnosticCode = 'sequence-store-unavailable' | 'legacy-cancel-normalized' | 'inbound-illegal-transition' | 'self-check-failed' | 'janitor-cleared' | 'duplicate-request-ignored' | 'dispatch-rejected' | 'will-not-armed'`
    - `interface DiagnosticEvent { code: DiagnosticCode; detail?: unknown; at: Date }`
    - `interface ClientHealth { connection: ConnectionState; since: Date; lastConnectionChange: Date; entities: { self: Uuid[]; managed: Uuid[] }; subscriptions: number; activeRequests: { sent: number; serving: number }; counters: { published: number; received: number; validationWarnings: number; rejections: number } }`
  - `class Iso21423Client` — `static connect(opts: ClientOptions): Promise<Iso21423Client>`; `registerSelfEntity`, `registerManagedEntity`, `listManagedEntities`, `subscribeEntities`, `subscribeResource`, `subscribeRequests`, `subscribeRequestStatus`, `discover`, `setDefaultExecutionPolicy`, `health`, `on`, `close` (signatures per `nodejs_api.md` §6)
  - `interface ClientOptions { transport?: MqttTransport; url?: string; security?: SecurityOptions; validateOutbound?: boolean; sourceId?: Uuid; sequenceStore?: SequenceStore | null; requestTimeoutMs?: number }`
  - `class EntityHandle` — `entityUuid`, `entityType`, `ownershipMode`, `publishIdentity`, `updateIdentity`, `publishStatus`, `publishBatteryStatus`, `publishOdometry`, `publishLocalTrajectory`, `publishGlobalPath`, `publishGlobalPlan`, `unregister` (requester/executor methods land in Tasks 4–7)
  - `interface EntityCatalogEntry { entityUuid: Uuid; entityType: string; identity: EntityIdentity; manages: readonly Uuid[]; managedBy?: Uuid; lost: boolean; firstSeen: Date; lastSeen: Date }`
  - `interface EntityCatalog { entities(): EntityCatalogEntry[]; get(uuid: Uuid): EntityCatalogEntry | undefined; managedBy(uuid: Uuid): EntityCatalogEntry[]; on(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void }`
  - Internal seam used by Tasks 4–7: `interface EntityContext { session: Iso21423Session; ref: EntityRef; sequence: SequenceCounter; catalog: EntityCache; diagnostic(code: DiagnosticCode, detail?: unknown): void; countPublish(): void; requestTimeoutMs: number }` — Task 4 adds `sendCancel(handle, actionId?)` and `trackInFlight(handle)`, Task 6 adds `policy(): ExecutionPolicy`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/coreClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Iso21423Client, EntityFilter, Iso21423Error } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR_UUID = '91403a21-7534-4467-99a6-79c46a130fe8';
const FLEET_UUID = '42177726-26f7-4f5c-b735-a12a427bb96d';
const ns = (t: string, u: string, r: string) => `/ISO_21423/v1/${t}/${u}/${r}`;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const registration = {
  entityUuid: IMR_UUID,
  entityType: 'IMR',
  manufacturerName: 'Acme Robotics',
  details: { imrModel: 'AR-2', imrSerialNumber: 'SN-0042' },
  capabilities: { provides: ['status', 'odometry'], accepts: ['move', 'cancelRequest'] },
};

async function client(broker: MemoryBroker) {
  return Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
}

describe('registration', () => {
  it('publishes a retained identity with capabilities wrapped per the schema', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    expect(imr.entityUuid).toBe(IMR_UUID);
    expect(imr.ownershipMode).toBe('self');
    const retained = broker.retainedOn(ns('IMR', IMR_UUID, 'identity'));
    const identity = JSON.parse(retained!.toString()) as {
      id: string; entityType: string; capabilities: { accepts: { requests: string[] } };
    };
    expect(identity.id).toBe(IMR_UUID);
    expect(identity.entityType).toBe('IMR');
    expect(identity.capabilities.accepts).toEqual({ requests: ['move', 'cancelRequest'] });
  });

  it('arms the B.4 will for the first registered self entity (P-4, decision 1)', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    const c = await Iso21423Client.connect({ transport, sequenceStore: null });
    await c.registerSelfEntity(registration);
    transport.dropConnection();
    await flush();
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'disconnection'))?.toString())
      .toBe('{"states":["LOST_CONNECTION"]}');
  });

  it('refuses a self registration after the session opened identity-less', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.subscribeEntities(EntityFilter.all(), () => {});
    await expect(c.registerSelfEntity(registration)).rejects.toThrow(/register.*before/i);
  });

  it('links managed entities both ways (D-11)', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.registerSelfEntity({
      entityUuid: FLEET_UUID, entityType: 'IMRFM', manufacturerName: 'Acme Fleet',
    });
    const imr = await c.registerManagedEntity(FLEET_UUID, registration);
    expect(imr.ownershipMode).toBe('managed');
    const managed = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))!.toString()) as {
      capabilities: { managedBy?: string };
    };
    const manager = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET_UUID, 'identity'))!.toString()) as {
      capabilities: { manages?: string[] };
    };
    expect(managed.capabilities.managedBy).toBe(FLEET_UUID);
    expect(manager.capabilities.manages).toEqual([IMR_UUID]);
    expect(c.listManagedEntities(FLEET_UUID).map((h) => h.entityUuid)).toEqual([IMR_UUID]);
  });

  it('rejects a managed entity whose manager is not a registered self entity', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await expect(c.registerManagedEntity(FLEET_UUID, registration)).rejects.toThrow(Iso21423Error);
  });
});

describe('resource publication', () => {
  it('fills entityId/timestamp and applies Table B.1 qos/retain', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishStatus({ states: ['MODE_AUTO', 'IDLE'] });
    const [msg] = broker.messagesOn(ns('IMR', IMR_UUID, 'status'));
    const body = JSON.parse(msg!.payload.toString()) as { entityId: string; timestamp: string };
    expect(msg!.qos).toBe(1);
    expect(msg!.retain).toBe(true);
    expect(body.entityId).toBe(IMR_UUID);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('maps localTrajectory points onto the schema field name', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishLocalTrajectory({
      points: [{
        timestamp: '2025-04-08T12:34:56.789Z',
        locationPoint: { ccsId: FLEET_UUID, x: 1, y: 2, z: 0 },
      }],
    });
    const [msg] = broker.messagesOn(ns('IMR', IMR_UUID, 'localTrajectory'));
    expect(Object.keys(JSON.parse(msg!.payload.toString()) as object)).toEqual(
      ['timestamp', 'localTrajectory']);
  });

  it('updateIdentity republishes the merged retained identity', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.updateIdentity({ manufacturerName: 'Acme Robotics GmbH' });
    const identity = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))!.toString()) as {
      manufacturerName: string; capabilities: { accepts: { requests: string[] } };
    };
    expect(identity.manufacturerName).toBe('Acme Robotics GmbH');
    expect(identity.capabilities.accepts.requests).toEqual(['move', 'cancelRequest']);
  });

  it('unregister publishes a final OFFLINE status and clears the other retained topics', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishBatteryStatus({ batterySoc: 0.5 });
    await imr.unregister();
    const status = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'status'))!.toString()) as {
      states: string[];
    };
    expect(status.states).toEqual(['OFFLINE']);
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))).toBeUndefined();
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'batteryStatus'))).toBeUndefined();
  });
});

describe('observation', () => {
  it('subscribeResource compiles the filter and delivers typed events', async () => {
    const broker = new MemoryBroker();
    const producer = await client(broker);
    const imr = await producer.registerSelfEntity(registration);
    const observer = await client(broker);
    const seen: Array<{ entityUuid: string; states: string[] }> = [];
    const sub = await observer.subscribeResource('status', EntityFilter.ofType('IMR'),
      (ev) => seen.push({ entityUuid: ev.entityUuid, states: (ev.message as { states: string[] }).states }));
    expect(sub.topicFilters).toEqual(['/ISO_21423/v1/IMR/+/status']);
    await imr.publishStatus({ states: ['MODE_AUTO', 'CHARGING'] });
    await flush();
    expect(seen).toEqual([{ entityUuid: IMR_UUID, states: ['MODE_AUTO', 'CHARGING'] }]);
    await sub.unsubscribe();
    expect(sub.active).toBe(false);
  });

  it('subscribeEntities replays retained identities to a late observer (D-18)', async () => {
    const broker = new MemoryBroker();
    const producer = await client(broker);
    await producer.registerSelfEntity(registration);
    const observer = await client(broker);
    const ids: string[] = [];
    await observer.subscribeEntities(EntityFilter.all(), (id) => ids.push(id.id));
    await flush();
    expect(ids).toEqual([IMR_UUID]);
  });

  it('health() reports connection, entities and counters (ND-18)', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.registerSelfEntity(registration);
    const h = c.health();
    expect(h.connection).toBe('connected');
    expect(h.entities.self).toEqual([IMR_UUID]);
    expect(h.counters.published).toBeGreaterThan(0);
  });
});
```

```typescript
// test/coreEntityCache.test.ts
import { describe, it, expect } from 'vitest';
import { Iso21423Client } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const FLEET = '42177726-26f7-4f5c-b735-a12a427bb96d';
const IMR = '91403a21-7534-4467-99a6-79c46a130fe8';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

async function deployment(broker: MemoryBroker) {
  const fleetClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null,
  });
  const fleet = await fleetClient.registerSelfEntity({
    entityUuid: FLEET, entityType: 'IMRFM', manufacturerName: 'Acme Fleet',
  });
  const imr = await fleetClient.registerManagedEntity(FLEET, {
    entityUuid: IMR, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move'] },
  });
  return { fleetClient, fleet, imr };
}

describe('discover() — retained-identity catalog only (D-18)', () => {
  it('builds the manages/managedBy graph from retained identities', async () => {
    const broker = new MemoryBroker();
    await deployment(broker);
    const observer = await Iso21423Client.connect({
      transport: broker.createTransport(), sequenceStore: null,
    });
    const catalog = observer.discover();
    await flush();
    expect(catalog.entities().map((e) => e.entityUuid).sort()).toEqual([IMR, FLEET].sort());
    expect(catalog.get(IMR)!.managedBy).toBe(FLEET);
    expect(catalog.managedBy(FLEET).map((e) => e.entityUuid)).toEqual([IMR]);
  });

  it('marks entities lost from the retained disconnection message and clears it on reconnect', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    const fleetClient = await Iso21423Client.connect({ transport, sequenceStore: null });
    await fleetClient.registerSelfEntity({
      entityUuid: FLEET, entityType: 'IMRFM', manufacturerName: 'Acme Fleet',
    });
    const observer = await Iso21423Client.connect({
      transport: broker.createTransport(), sequenceStore: null,
    });
    const catalog = observer.discover();
    const lost: string[] = [];
    catalog.on('lost', (e) => lost.push(e.entityUuid));
    await flush();
    transport.dropConnection();
    await flush();
    expect(lost).toEqual([FLEET]);
    expect(catalog.get(FLEET)!.lost).toBe(true);
  });

  it('drops entities whose identity is zero-byte cleared', async () => {
    const broker = new MemoryBroker();
    const { imr } = await deployment(broker);
    const observer = await Iso21423Client.connect({
      transport: broker.createTransport(), sequenceStore: null,
    });
    const catalog = observer.discover();
    await flush();
    expect(catalog.get(IMR)).toBeDefined();
    await imr.unregister();
    await flush();
    expect(catalog.get(IMR)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/coreClient.test.ts test/coreEntityCache.test.ts`
Expected: FAIL — `Iso21423Client` not exported.

- [ ] **Step 3: Implement `src/core/types.ts`**

```typescript
// src/core/types.ts
import type { IsoTimestamp, Uuid } from '../types/common.js';
import type { ConnectionState } from '../session/transport.js';
import type { OperatingState, ReasonCode, RequestState, DetailState } from '../types/constants.js';
import type { Capabilities, EntityIdentity } from '../types/identity.js';
import type { LocationPointStamped } from '../types/telemetry.js';
import type { Request, RequestDetail } from '../types/requests.js';
import { nowTimestamp } from '../types/common.js';
import type { ResourceKind } from './resources.js';

/** nodejs_api.md calls the wire enum StatusReason; Plan 1 named it ReasonCode (decision 9). */
export type StatusReason = ReasonCode;

export type WithOptionalTimestamp<T> = Omit<T, 'timestamp'> & { timestamp?: Date | IsoTimestamp };

/** Accept Date or string at API boundaries; always emit dot-decimal ISO 8601 (ND-07). */
export function toTimestamp(t?: Date | IsoTimestamp): IsoTimestamp {
  if (typeof t === 'string') return t;
  return nowTimestamp(t ?? new Date());
}

export interface EntityRegistration {
  entityUuid: Uuid;
  entityType: string;
  manufacturerName: string;
  iso21423Version?: string;
  details?: Record<string, unknown>;
  /** `accepts` are action type names; the SDK wraps them into `{ requests: [...] }` (schema shape). */
  capabilities?: { provides?: string[]; accepts?: string[] };
  executionPolicy?: import('./policies.js').ExecutionPolicy;
}

export type ManagedEntityRegistration = EntityRegistration;

export interface StatusUpdate {
  states: OperatingState[];
  disabledCapabilities?: Capabilities;
  timestamp?: Date | IsoTimestamp;
}

/** Wire field is `localTrajectory` (schema); the API takes `points` (example_imr.md §2). */
export interface LocalTrajectoryUpdate {
  points: LocationPointStamped[];
  timestamp?: Date | IsoTimestamp;
}

export interface ResourceEvent<T = unknown> {
  entityType: string;
  entityUuid: Uuid;
  kind: ResourceKind;
  topic: string;
  message: T;
}

export interface RequestEvent {
  entityType: string;
  entityUuid: Uuid;
  requestUuid: Uuid;
  request: Request;
  topic: string;
}

export interface SecurityOptions {
  username?: string;
  password?: string;
  /** Passed through to the transport (TLS/mTLS material) — ND-15. */
  tls?: Record<string, unknown>;
  /** Identity-echo publish self-check: default off for clients, on for FleetGateway. */
  selfCheck?: boolean;
  selfCheckTimeoutMs?: number;
}

export type DiagnosticCode =
  | 'sequence-store-unavailable' | 'legacy-cancel-normalized' | 'inbound-illegal-transition'
  | 'self-check-failed' | 'janitor-cleared' | 'duplicate-request-ignored'
  | 'dispatch-rejected' | 'will-not-armed';

export interface DiagnosticEvent { code: DiagnosticCode; detail?: unknown; at: Date }

export interface ClientHealth {
  connection: ConnectionState;
  since: Date;
  lastConnectionChange: Date;
  entities: { self: Uuid[]; managed: Uuid[] };
  subscriptions: number;
  activeRequests: { sent: number; serving: number };
  counters: { published: number; received: number; validationWarnings: number; rejections: number };
}

/** Requester-side command (Task 4). */
export interface RequestCommand {
  destination: Uuid | '';
  /** Destination namespace type; resolved from the identity catalog, else 'IMR' (decision 2). */
  destinationType?: string;
  details: RequestDetail[];
  recoveries?: RequestDetail[];
  priority?: number;
  atomic?: boolean;
  requestUuid?: Uuid;
  /** Local-only RECEIVED deadline (D-14); default from ClientOptions.requestTimeoutMs. */
  timeoutMs?: number;
  /** Set false to skip the discovered-capability check (decision 4). */
  requireCapability?: boolean;
}

/** Executor-side updates (Tasks 5–7). */
export interface RequestStatusUpdate { status: RequestState; reason?: StatusReason; message?: string }
export interface RequestDetailStatusUpdate {
  index: number;
  status: DetailState;
  reason?: StatusReason;
  message?: string;
  properties?: Record<string, unknown>;
}
export interface RequestTerminalUpdate {
  status: Extract<RequestState, 'SUCCEEDED' | 'ABORTED' | 'CANCELED'>;
  reason?: StatusReason;
  message?: string;
}

export type TypedRequestDetail<P = Record<string, unknown>> =
  Omit<RequestDetail, 'properties'> & { properties: P };

export type ActionResult =
  | { outcome: 'succeeded'; properties?: Record<string, unknown> }
  | { outcome: 'aborted'; reason: StatusReason; message?: string };

export interface ActionContext {
  readonly entity: import('./entityHandle.js').EntityHandle;
  readonly request: Request;
  readonly signal: AbortSignal;
  progress(properties: Record<string, unknown>): void;
  succeeded(properties?: Record<string, unknown>): ActionResult;
  aborted(reason: StatusReason, message?: string): ActionResult;
}

export type ActionHandler<P = Record<string, unknown>> =
  (action: TypedRequestDetail<P>, ctx: ActionContext) => Promise<ActionResult>;

export type { EntityIdentity };
```

- [ ] **Step 4: Implement `src/core/entityCache.ts`**

```typescript
// src/core/entityCache.ts
import type { Uuid } from '../types/common.js';
import type { EntityIdentity } from '../types/identity.js';
import type { Iso21423Session, TopicMeta } from '../session/session.js';
import { validateMessage } from '../schema/validators.js';
import { ROOT_NAMESPACE, LOST_CONNECTION_STATE } from '../types/constants.js';

export interface EntityCatalogEntry {
  entityUuid: Uuid;
  entityType: string;
  identity: EntityIdentity;
  manages: readonly Uuid[];
  managedBy?: Uuid;
  lost: boolean;
  firstSeen: Date;
  lastSeen: Date;
}

export interface EntityCatalog {
  entities(): EntityCatalogEntry[];
  get(uuid: Uuid): EntityCatalogEntry | undefined;
  managedBy(uuid: Uuid): EntityCatalogEntry[];
  on(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void;
}

/**
 * Best-effort local catalog built purely from retained `identity` messages (D-18) —
 * never a broker query. Also backs destination-type resolution and capability checks.
 */
export class EntityCache implements EntityCatalog {
  private readonly byUuid = new Map<Uuid, EntityCatalogEntry>();
  private readonly listeners: Record<'entity' | 'lost' | 'gone', Array<(e: EntityCatalogEntry) => void>> =
    { entity: [], lost: [], gone: [] };
  private disconnectionSubscribed = false;

  constructor(private readonly session: Iso21423Session) {}

  /** Subscribed once per client session (decision 3): identities are cheap and always needed. */
  async start(): Promise<void> {
    // kind: null — a zero-byte retained clear must be seen as a removal, not a warning.
    await this.session.subscribeTopic(
      `${ROOT_NAMESPACE}/+/+/identity`, null, (raw, meta) => this.onIdentity(raw, meta),
      { qos: 1 });
  }

  /** Disconnection tracking is only wired when someone actually calls discover(). */
  async watchDisconnections(): Promise<void> {
    if (this.disconnectionSubscribed) return;
    this.disconnectionSubscribed = true;
    await this.session.subscribeTopic(
      `${ROOT_NAMESPACE}/+/+/disconnection`, null, (raw, meta) => this.onDisconnection(raw, meta),
      { qos: 1 });
  }

  entities(): EntityCatalogEntry[] { return [...this.byUuid.values()]; }
  get(uuid: Uuid): EntityCatalogEntry | undefined { return this.byUuid.get(uuid); }
  managedBy(uuid: Uuid): EntityCatalogEntry[] {
    return this.entities().filter((e) => e.managedBy === uuid);
  }

  on(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void {
    this.listeners[event].push(cb);
  }

  /** Destination entityType resolution for request topics (decision 2). */
  entityTypeOf(uuid: Uuid): string | undefined { return this.byUuid.get(uuid)?.entityType; }

  /** Known-accepts lookup for NotCapableError (decision 4); undefined = unknown entity. */
  acceptsOf(uuid: Uuid): string[] | undefined {
    const entry = this.byUuid.get(uuid);
    if (!entry) return undefined;
    return entry.identity.capabilities?.accepts?.requests;
  }

  private onIdentity(raw: unknown, meta: TopicMeta): void {
    const text = typeof raw === 'string' ? raw : '';
    if (text.length === 0) {
      const gone = this.byUuid.get(meta.entityUuid);
      if (gone) {
        this.byUuid.delete(meta.entityUuid);
        this.emit('gone', gone);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;                                   // third-party noise never breaks the catalog
    }
    const result = validateMessage('entityIdentity', parsed);
    if (!result.ok) return;
    const identity = result.value as EntityIdentity;
    const now = new Date();
    const prev = this.byUuid.get(meta.entityUuid);
    const entry: EntityCatalogEntry = {
      entityUuid: meta.entityUuid,
      entityType: identity.entityType ?? meta.entityType,
      identity,
      manages: identity.capabilities?.manages ?? [],
      managedBy: identity.capabilities?.managedBy,
      lost: false,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    };
    this.byUuid.set(entry.entityUuid, entry);
    this.emit('entity', entry);
  }

  private onDisconnection(raw: unknown, meta: TopicMeta): void {
    const entry = this.byUuid.get(meta.entityUuid);
    if (!entry) return;
    const text = typeof raw === 'string' ? raw : '';
    const lost = text.length > 0 && text.includes(LOST_CONNECTION_STATE);
    if (lost === entry.lost) return;
    const updated = { ...entry, lost, lastSeen: new Date() };
    this.byUuid.set(entry.entityUuid, updated);
    if (lost) this.emit('lost', updated);
  }

  private emit(event: 'entity' | 'lost' | 'gone', e: EntityCatalogEntry): void {
    for (const cb of this.listeners[event]) cb(e);
  }
}
```

- [ ] **Step 5: Implement `src/core/entityHandle.ts` (publication surface)**

```typescript
// src/core/entityHandle.ts
import type { Iso21423Session } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import type { Uuid } from '../types/common.js';
import type { OperatingState } from '../types/constants.js';
import type { BatteryStatus, GlobalPath, GlobalPlan, Odometry } from '../types/telemetry.js';
import type { EntityIdentity } from '../types/identity.js';
import { PROTOCOL_VERSION } from '../types/constants.js';
import { messageKindFor } from './resources.js';
import {
  toTimestamp, type EntityRegistration, type LocalTrajectoryUpdate, type StatusUpdate,
  type WithOptionalTimestamp,
} from './types.js';
import type { SequenceCounter } from './sequence.js';
import type { EntityCache } from './entityCache.js';
import type { DiagnosticCode } from './types.js';

/** Internal seam shared by the publication, requester and executor mixins (Tasks 4–7). */
export interface EntityContext {
  session: Iso21423Session;
  ref: EntityRef;
  sequence: SequenceCounter;
  catalog: EntityCache;
  diagnostic(code: DiagnosticCode, detail?: unknown): void;
  countPublish(): void;
  requestTimeoutMs: number;
}

const RETAINED_RESOURCES = [
  'identity', 'batteryStatus', 'globalPath', 'globalPlan', 'activeRequestsStatus', 'disconnection',
] as const;

export class EntityHandle {
  #identity: EntityIdentity;
  #states: OperatingState[] = [];

  /** @internal — constructed by Iso21423Client.registerSelfEntity/registerManagedEntity. */
  constructor(
    readonly ctx: EntityContext,
    readonly ownershipMode: 'self' | 'managed',
    registration: EntityRegistration,
  ) {
    this.#identity = {
      id: registration.entityUuid,
      timestamp: toTimestamp(),
      entityType: registration.entityType,
      manufacturerName: registration.manufacturerName,
      iso21423Version: registration.iso21423Version ?? PROTOCOL_VERSION,
      capabilities: {
        provides: registration.capabilities?.provides ?? [],
        accepts: { requests: registration.capabilities?.accepts ?? [] },
      },
      details: registration.details ?? {},
    };
  }

  get entityUuid(): Uuid { return this.ctx.ref.entityUuid; }
  get entityType(): string { return this.ctx.ref.entityType; }
  /** Last states this handle published — feeds the automatic INVALID_IMR_STATE_FOR_ACTION rule. */
  lastStates(): readonly OperatingState[] { return this.#states; }
  identity(): EntityIdentity { return this.#identity; }

  async publishIdentity(identity: EntityIdentity): Promise<void> {
    this.#identity = { ...identity, timestamp: toTimestamp(identity.timestamp) };
    await this.publish('identity', this.#identity);
  }

  async updateIdentity(partial: Partial<EntityIdentity>): Promise<void> {
    await this.publishIdentity({ ...this.#identity, ...partial, timestamp: toTimestamp() });
  }

  async publishStatus(update: StatusUpdate): Promise<void> {
    this.#states = [...update.states];
    await this.publish('status', {
      entityId: this.entityUuid,
      timestamp: toTimestamp(update.timestamp),
      states: update.states,
      ...(update.disabledCapabilities ? { disabledCapabilities: update.disabledCapabilities } : {}),
    });
  }

  async publishBatteryStatus(update: WithOptionalTimestamp<BatteryStatus>): Promise<void> {
    await this.publish('batteryStatus', { ...update, timestamp: toTimestamp(update.timestamp) });
  }

  async publishOdometry(sample: WithOptionalTimestamp<Odometry>): Promise<void> {
    await this.publish('odometry', { ...sample, timestamp: toTimestamp(sample.timestamp) });
  }

  async publishLocalTrajectory(sample: LocalTrajectoryUpdate): Promise<void> {
    await this.publish('localTrajectory', {
      timestamp: toTimestamp(sample.timestamp),
      localTrajectory: sample.points,
    });
  }

  async publishGlobalPath(snapshot: WithOptionalTimestamp<GlobalPath>): Promise<void> {
    await this.publish('globalPath', { ...snapshot, timestamp: toTimestamp(snapshot.timestamp) });
  }

  async publishGlobalPlan(snapshot: WithOptionalTimestamp<GlobalPlan>): Promise<void> {
    await this.publish('globalPlan', { ...snapshot, timestamp: toTimestamp(snapshot.timestamp) });
  }

  /** Final OFFLINE status stays as the tombstone; every other retained topic is cleared. */
  async unregister(): Promise<void> {
    await this.publishStatus({ states: ['OFFLINE'] });
    for (const resource of RETAINED_RESOURCES) {
      await this.ctx.session.clearRetained(
        `${this.ctx.session.topicFor(this.ctx.ref, resource)}`);
    }
  }

  private async publish(resource: string, payload: unknown): Promise<void> {
    await this.ctx.session.publishResource(
      this.ctx.ref, resource, messageKindFor(resource), payload);
    this.ctx.countPublish();
  }
}
```

Implementer notes:
- add a tiny `topicFor(ref, resource)` passthrough to `Iso21423Session` (it already imports `topicFor`) so `/core` never rebuilds topics itself;
- `publishStatus` must run through `session.publishResource` so the ND-08 on-change guard applies; `unregister()`'s OFFLINE publish therefore no-ops if OFFLINE was already the last status — acceptable and correct.

- [ ] **Step 6: Implement `src/core/client.ts`**

Behavior to implement exactly (no code sketch for the plumbing — the shape is fixed by the tests above and by `nodejs_api.md` §6):

- `static async connect(opts)`: validate that exactly one of `transport` / `url` is given (`Iso21423Error` otherwise; `url` builds `createMqttTransport(url, { ...opts.security })`). Store options. **Do not open the session** (decision 1). `sequenceStore` defaults to a shared `FileSequenceStore()`; `null` disables persistence (epoch-ms seeds, used by tests); `requestTimeoutMs` defaults to `5000`.
- `private async ensureSession(self?: EntityRef)`: idempotent. On first call, `Iso21423Session.connect({ transport, entity: self ?? identitylessRef(), credentials, validateOutbound })` where `identitylessRef()` is `{ entityType: 'client', entityUuid: opts.sourceId ?? randomUUID() }` and **no will** is armed (`Iso21423Session.connect` gains an `arm Will: boolean` option, default `true`; the client passes `false` for the identity-less case and emits `diagnostic('will-not-armed')`). Then relay session `connection` / `validation-warning` events to client listeners (counting `validationWarnings`), and `await this.cache.start()`.
- `registerSelfEntity(reg)`: `await this.ensureSession({ entityType: reg.entityType, entityUuid: reg.entityUuid })`; if the session was already open with a different (or identity-less) entity, throw `Iso21423Error('register the self entity before any other operation, so the B.4 Last Will can be armed at connect time (P-4)')`. Open a `SequenceCounter` for the uuid (diagnostic `sequence-store-unavailable` on fallback), build the `EntityHandle`, `await handle.publishIdentity(handle.identity())`, run the publish self-check when `security.selfCheck`, record it in `#self`, return it.
- `registerManagedEntity(managerUuid, reg)`: throw `Iso21423Error` unless `managerUuid` is a registered self handle. Default `reg.entityType` to `'IMR'`. Build the handle with `ownershipMode: 'managed'`, set `identity.capabilities.managedBy = managerUuid`, publish it, then append the uuid to the manager's `capabilities.manages` and `await manager.updateIdentity(...)` (B.5.2.4 link maintenance). Track in `#managed: Map<Uuid, EntityHandle[]>`.
- `listManagedEntities(managerUuid): EntityHandle[]` — snapshot copy.
- `subscribeEntities(filter, handler)`: `subscribeResource('identity', filter, ev => handler(ev.message as EntityIdentity))`, returning the same composed `Subscription`.
- `subscribeResource(kind, filter, handler)`: `await this.ensureSession()`, compile `filter.topicFiltersFor(kind)`, one `session.subscribeTopic(f, messageKindFor(kind), …)` per filter, wrap with `composeSubscription`. Each delivery builds a `ResourceEvent` from `TopicMeta` and increments the `received` counter.
- `subscribeRequests(filter, handler)` / `subscribeRequestStatus(filter, handler)`: same pattern over `filter.topicFilters()` with kinds `'request'` / `'requestStatus'`; `subscribeRequests` builds `RequestEvent` (skipping empty retained-clear payloads).
- `discover(): EntityCatalog`: `await`-free — returns the shared `EntityCache` and kicks off `void this.cache.watchDisconnections()` once. Requires an open session; if none is open yet, open it (identity-less) first via a queued `void this.ensureSession()`; the catalog fills as retained messages arrive.
- `setDefaultExecutionPolicy(policy)` (Task 6 wires it), `health()` (assemble `ClientHealth` from counters/state), `on(event, cb)` for `'connection' | 'validation-warning' | 'diagnostic'`.
- `close(opts?)`: reject every in-flight `completion()` with `BrokerUnavailable`, unsubscribe tracked subscriptions, `await session.close()` (graceful — will suppressed), then mark closed. A never-connected client closes as a no-op. `opts.timeout` (default 5000 ms) caps the wait on the session close.

- [ ] **Step 7: Export and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './types.js';
export * from './entityCache.js';
export * from './entityHandle.js';
export * from './client.js';
```

Run: `npx vitest run test/coreClient.test.ts test/coreEntityCache.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat: Iso21423Client, EntityHandle publication surface, retained-identity catalog"
```

---

### Task 4: Requester side — `EntityHandle.sendRequest` and `RequestHandle`

**Files:**
- Create: `src/core/requestHandle.ts`
- Modify: `src/core/entityHandle.ts`, `src/core/index.ts`
- Test: `test/coreSendRequest.test.ts`

**Interfaces:**
- Consumes: `EntityContext`, `RequestCommand`, `SequenceCounter`, `EntityCache`, `composeSubscription`, `requestTopic`/`requestStatusTopic`, `RequestLifecycle`, `isTerminalRequestState`, `cancelRequest()` builder, `RequestFailed`, `RequestTimeout`, `NotCapableError`, `BrokerUnavailable`.
- Produces:
  - `EntityHandle.sendRequest(cmd: RequestCommand): Promise<RequestHandle>`
  - `class RequestHandle { readonly requestUuid: Uuid; readonly sourceUuid: Uuid; readonly sequenceId: number; readonly destination: Uuid | ''; readonly createdAt: Date; latestStatus(): RequestStatus | undefined; onStatus(handler: (s: RequestStatus) => void): Subscription; completion(): Promise<RequestStatus>; cancel(opts?: { actionId?: number }): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/coreSendRequest.test.ts
import { describe, it, expect } from 'vitest';
import {
  Iso21423Client, NotCapableError, RequestFailed, RequestTimeout, move, nowTimestamp,
} from '../src/index.js';
import { MemoryBroker, type MemoryTransport } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };

async function requester(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 50,
  });
  const handle = await c.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  return { client: c, handle };
}

/** Publish an identity for the destination so type + capabilities are discoverable. */
async function fakeRobot(broker: MemoryBroker, accepts: string[]) {
  const c = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
  await c.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts },
  });
  return c;
}

/** Minimal executor stand-in: publishes raw status messages on the request's status topic. */
function statusPublisher(broker: MemoryBroker) {
  const t: MemoryTransport = broker.createTransport();
  const ready = t.connect({ clientId: 'exec', cleanSession: false, keepalive: 60 });
  return async (requestUuid: string, status: string, extra: Record<string, unknown> = {}) => {
    await ready;
    await t.publish(
      `/ISO_21423/v1/IMR/${DST}/request/${requestUuid}/status`,
      JSON.stringify({
        source: DST, destination: SRC, sequenceId: 1, requestSequenceId: 1,
        timestamp: nowTimestamp(), status, detailStatuses: [], ...extra,
      }),
      { qos: 2, retain: true },
    );
  };
}

describe('sendRequest', () => {
  it('publishes a conformant retained request at QoS 2 with an SDK-assigned sequenceId', async () => {
    const broker = new MemoryBroker();
    await fakeRobot(broker, ['move']);
    const { handle } = await requester(broker);
    await flush();
    const req = await handle.sendRequest({ destination: DST, details: [move(target)] });
    const topic = `/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}`;
    const [msg] = broker.messagesOn(topic);
    const body = JSON.parse(msg!.payload.toString()) as {
      source: string; destination: string; sequenceId: number; details: Array<{ type: string }>;
    };
    expect(msg!.qos).toBe(2);
    expect(msg!.retain).toBe(true);
    expect(body.source).toBe(SRC);
    expect(body.destination).toBe(DST);
    expect(body.sequenceId).toBe(req.sequenceId);
    expect(body.details[0]!.type).toBe('move');
  });

  it('increments sequenceId per request from the same handle (D-15)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const a = await handle.sendRequest({ destination: DST, destinationType: 'IMR', details: [move(target)] });
    const b = await handle.sendRequest({ destination: DST, destinationType: 'IMR', details: [move(target)] });
    expect(b.sequenceId).toBe(a.sequenceId + 1);
  });

  it('throws NotCapableError only when the destination is known not to accept the action', async () => {
    const broker = new MemoryBroker();
    await fakeRobot(broker, ['dock']);
    const { handle } = await requester(broker);
    await flush();
    await expect(handle.sendRequest({ destination: DST, details: [move(target)] }))
      .rejects.toThrow(NotCapableError);
    await expect(handle.sendRequest({
      destination: DST, details: [move(target)], requireCapability: false,
    })).resolves.toBeDefined();
    await expect(handle.sendRequest({
      destination: '11111111-1111-4111-8111-111111111111', destinationType: 'Door',
      details: [{ type: 'openDoor', version: '1.0', properties: {} }],
    })).resolves.toBeDefined();          // unknown entity → no claim, no throw
  });

  it('streams status and resolves completion() on SUCCEEDED (D-16)', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    const seen: string[] = [];
    req.onStatus((s) => seen.push(s.status));
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'ACCEPTED');
    await publish(req.requestUuid, 'EXECUTING');
    await publish(req.requestUuid, 'SUCCEEDED');
    const final = await req.completion();
    expect(seen).toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'SUCCEEDED']);
    expect(final.status).toBe('SUCCEEDED');
    expect(req.latestStatus()!.status).toBe('SUCCEEDED');
  });

  it('rejects completion() with RequestFailed on ABORTED', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'ABORTED');
    await expect(req.completion()).rejects.toThrow(RequestFailed);
  });

  it('zero-byte-clears the retained request on a terminal status (ND-10, B.5.3)', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    const topic = `/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}`;
    expect(broker.retainedOn(topic)).toBeDefined();
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'SUCCEEDED');
    await req.completion();
    expect(broker.retainedOn(topic)).toBeUndefined();
  });

  it('raises a local-only RequestTimeout when no RECEIVED arrives (D-14)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)], timeoutMs: 20,
    });
    await expect(req.completion()).rejects.toThrow(RequestTimeout);
    // Never published as a protocol state change:
    expect(broker.messagesOn(`/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}/status`))
      .toHaveLength(0);
  });

  it('cancel() sends a cancelRequest naming (source, requestId) — D-02, Table C.4', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    await req.cancel();
    const cancelMsg = broker.messagesUnder(`/ISO_21423/v1/IMR/${DST}/request/`)
      .find((m) => m.payload.toString().includes('cancelRequest'));
    const body = JSON.parse(cancelMsg!.payload.toString()) as {
      source: string; sequenceId: number; details: Array<{ type: string; properties: unknown }>;
    };
    expect(body.details[0]!.type).toBe('cancelRequest');
    expect(body.details[0]!.properties).toEqual({ source: SRC, requestId: req.sequenceId });
    expect(body.sequenceId).toBe(req.sequenceId + 1);       // the cancel is its own request
  });
});
```

This test needs one more introspection helper on `MemoryBroker` in `src/testing/memoryTransport.ts`:

```typescript
  /** Every logged message whose topic starts with `prefix` (test convenience). */
  messagesUnder(prefix: string): TransportMessage[] {
    return this.log.filter((m) => m.topic.startsWith(prefix));
  }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/coreSendRequest.test.ts`
Expected: FAIL — `sendRequest` is not a function.

- [ ] **Step 3: Implement `RequestHandle` and the sender**

```typescript
// src/core/requestHandle.ts
import { randomUUID } from 'node:crypto';
import type { Uuid } from '../types/common.js';
import type { Request, RequestStatus } from '../types/requests.js';
import type { EntityRef } from '../topics/topics.js';
import { requestStatusTopic, requestTopic } from '../topics/topics.js';
import { isTerminalRequestState } from '../requests/stateMachine.js';
import { BrokerUnavailable, RequestFailed, RequestTimeout } from '../errors.js';
import { composeSubscription, type Subscription } from './subscription.js';
import type { EntityContext } from './entityHandle.js';

export class RequestHandle {
  readonly createdAt = new Date();
  #latest?: RequestStatus;
  #listeners: Array<(s: RequestStatus) => void> = [];
  #settled = false;
  #resolve!: (s: RequestStatus) => void;
  #reject!: (e: Error) => void;
  #completion: Promise<RequestStatus>;
  #timer?: ReturnType<typeof setTimeout>;
  #statusSub?: { unsubscribe(): Promise<void> };

  /** @internal */
  constructor(
    private readonly ctx: EntityContext,
    private readonly destRef: EntityRef,
    readonly requestUuid: Uuid,
    readonly sourceUuid: Uuid,
    readonly sequenceId: number,
    readonly destination: Uuid | '',
    private readonly timeoutMs: number,
  ) {
    this.#completion = new Promise<RequestStatus>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Never surfaces as an unhandled rejection if the caller only uses onStatus().
    this.#completion.catch(() => undefined);
  }

  /** @internal — called by sendRequest once the status subscription is live. */
  armTimeout(sub: { unsubscribe(): Promise<void> }): void {
    this.#statusSub = sub;
    this.#timer = setTimeout(() => {
      this.settle(new RequestTimeout(
        `no RECEIVED for request ${this.requestUuid} within ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    this.#timer.unref?.();
  }

  /** @internal — one inbound requestStatus message. */
  ingest(status: RequestStatus): void {
    this.#latest = status;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    for (const cb of this.#listeners) cb(status);
    if (!isTerminalRequestState(status.status)) return;
    void this.cleanup();
    if (status.status === 'SUCCEEDED') this.settle(undefined, status);
    else this.settle(new RequestFailed(`request ${this.requestUuid} ended ${status.status}`, status));
  }

  /** @internal — connection lost while in flight (nodejs_api.md §12). */
  failFast(): void {
    this.settle(new BrokerUnavailable(`broker unavailable during request ${this.requestUuid}`));
  }

  latestStatus(): RequestStatus | undefined { return this.#latest; }

  onStatus(handler: (s: RequestStatus) => void): Subscription {
    this.#listeners.push(handler);
    return composeSubscription([requestStatusTopic(this.destRef, this.requestUuid)], [{
      unsubscribe: async () => {
        this.#listeners = this.#listeners.filter((h) => h !== handler);
      },
    }]);
  }

  completion(): Promise<RequestStatus> { return this.#completion; }

  async cancel(opts: { actionId?: number } = {}): Promise<void> {
    await this.ctx.sendCancel(this, opts.actionId);
  }

  private settle(error?: Error, status?: RequestStatus): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    if (error) this.#reject(error);
    else this.#resolve(status!);
  }

  /** Sender duty: clear the retained request and drop the status subscription (ND-10). */
  private async cleanup(): Promise<void> {
    await this.ctx.session.clearRetained(requestTopic(this.destRef, this.requestUuid));
    await this.#statusSub?.unsubscribe();
  }

  static newUuid(): Uuid { return randomUUID(); }
  static buildRequest(fields: Omit<Request, 'timestamp'> & { timestamp: string }): Request {
    return fields;
  }
}
```

- [ ] **Step 4: Wire `sendRequest` into `EntityHandle`**

Add to `EntityHandle` (and extend `EntityContext` with `sendCancel(handle, actionId?)`, implemented by
the same method so `RequestHandle.cancel()` reuses it):

```typescript
  async sendRequest(cmd: RequestCommand): Promise<RequestHandle> {
    const destinationType = cmd.destinationType
      ?? (cmd.destination ? this.ctx.catalog.entityTypeOf(cmd.destination) : undefined)
      ?? 'IMR';                                            // decision 2
    const destRef = { entityType: destinationType, entityUuid: cmd.destination || this.entityUuid };

    if (cmd.requireCapability !== false && cmd.destination) {
      const accepts = this.ctx.catalog.acceptsOf(cmd.destination);   // undefined = unknown
      const missing = accepts && cmd.details
        .map((d) => d.type)
        .filter((t) => !accepts.includes(t));
      if (missing && missing.length > 0) {
        throw new NotCapableError(
          `entity ${cmd.destination} does not accept: ${missing.join(', ')} ` +
          `(pass requireCapability: false to send anyway)`);
      }
    }

    const sequenceId = await this.ctx.sequence.next();
    const requestUuid = cmd.requestUuid ?? randomUUID();
    const request: Request = {
      destination: cmd.destination,
      source: this.entityUuid,
      sequenceId,
      timestamp: toTimestamp(),
      ...(cmd.priority !== undefined ? { priority: cmd.priority } : {}),
      ...(cmd.atomic !== undefined ? { atomic: cmd.atomic } : {}),
      details: cmd.details,
      ...(cmd.recoveries ? { recoveries: cmd.recoveries } : {}),
    };

    const handle = new RequestHandle(
      this.ctx, destRef, requestUuid, this.entityUuid, sequenceId, cmd.destination,
      cmd.timeoutMs ?? this.ctx.requestTimeoutMs);

    // Subscribe to the status stream BEFORE publishing, so no status can be missed.
    const sub = await this.ctx.session.subscribeTopic(
      requestStatusTopic(destRef, requestUuid), 'requestStatus',
      (msg) => handle.ingest(msg as RequestStatus), { qos: 2 });
    this.ctx.trackInFlight(handle);
    handle.armTimeout(sub);

    await this.ctx.session.publishTopic(
      requestTopic(destRef, requestUuid), 'request', request, { qos: 2, retain: true });
    this.ctx.countPublish();
    return handle;
  }
```

`sendCancel(handle, actionId)` builds a **new** request to the same destination with
`details: [cancelRequest({ source: handle.sourceUuid, requestId: handle.sequenceId, ...(actionId !== undefined ? { actionId } : {}) })]`
and sends it through `sendRequest` with `requireCapability: false` (a target that accepted the
original request must be able to receive its cancel). Its own `RequestHandle` is returned to
`sendCancel`'s caller internally and discarded by `RequestHandle.cancel()`.

`ctx.trackInFlight(handle)` registers the handle with the client so `close()` and an `offline`
connection state can `failFast()` every in-flight request (`nodejs_api.md` §12) and so
`health().activeRequests.sent` is accurate; the client drops it on settle.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/coreSendRequest.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: requester side — sendRequest, RequestHandle status stream, timeout and retained cleanup"
```

---

### Task 5: Serving substrate — `acceptRequests` and `IncomingRequest`

**Files:**
- Create: `src/core/incomingRequest.ts`, `src/core/requestServer.ts`
- Modify: `src/core/entityHandle.ts`, `src/core/index.ts`
- Test: `test/coreAcceptRequests.test.ts`

**Interfaces:**
- Consumes: `EntityContext`, `RequestAcceptanceFilter`, `RequestLifecycle`/`DetailLifecycle`, `validateMessage`, `IllegalTransition`, topic helpers.
- Produces:
  - `EntityHandle.acceptRequests(filter: RequestAcceptanceFilter, handler: (req: IncomingRequest) => void): Promise<Subscription>`
  - `class IncomingRequest { readonly request: Request; readonly source: Uuid; readonly sequenceId: number; accept(): Promise<void>; reject(reason: StatusReason): Promise<void>; updateStatus(u: RequestStatusUpdate): Promise<void>; updateDetailStatus(u: RequestDetailStatusUpdate): Promise<void>; complete(t: RequestTerminalUpdate): Promise<void> }`
  - `class RequestServer` (internal, one per `EntityHandle`) — owns the `request/+` subscription, D-12/D-13 handling, duplicate suppression, `activeRequestsStatus` aggregation, and the executor hand-off used by Tasks 6–7.

- [ ] **Step 1: Write the failing test**

```typescript
// test/coreAcceptRequests.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  Iso21423Client, RequestAcceptanceFilter, IllegalTransition, move, nowTimestamp,
} from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';
const reqTopic = `/ISO_21423/v1/IMR/${DST}/request/${REQ}`;
const statusTopic = `${reqTopic}/status`;
const activeTopic = `/ISO_21423/v1/IMR/${DST}/activeRequestsStatus`;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  destination: DST, source: SRC, sequenceId: 1, timestamp: nowTimestamp(),
  details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })], ...over,
});

async function robot(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
  const h = await c.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move'] },
  });
  return { client: c, handle: h };
}

async function inject(broker: MemoryBroker, payload: string, topic = reqTopic) {
  const t = broker.createTransport();
  await t.connect({ clientId: `injector-${Math.random()}`, cleanSession: false, keepalive: 60 });
  await t.publish(topic, payload, { qos: 2, retain: true });
  await flush();
}

const statuses = (broker: MemoryBroker) =>
  broker.messagesOn(statusTopic).map((m) => (JSON.parse(m.payload.toString()) as { status: string }).status);

describe('acceptRequests substrate', () => {
  it('auto-publishes RECEIVED before the handler runs (D-12)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    let seenAtHandler: string[] = [];
    await handle.acceptRequests(RequestAcceptanceFilter.all(), () => {
      seenAtHandler = statuses(broker);
    });
    await inject(broker, body());
    expect(seenAtHandler).toEqual(['RECEIVED']);
  });

  it('auto-rejects schema-invalid requests without invoking the handler (D-13)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    const handler = vi.fn();
    await handle.acceptRequests(RequestAcceptanceFilter.all(), handler);
    await inject(broker, body({ details: 'not-an-array' }));
    expect(handler).not.toHaveBeenCalled();
    const last = JSON.parse(broker.messagesOn(statusTopic).at(-1)!.payload.toString()) as {
      status: string; detailStatuses: Array<{ status: { reason: string } }>;
    };
    expect(last.status).toBe('ABORTED');
    expect(broker.messagesOn(statusTopic).at(-1)!.payload.toString()).toContain('MALFORMED_REQUEST');
  });

  it('drives accept → EXECUTING → complete and aggregates activeRequestsStatus', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    await handle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      expect(req.source).toBe(SRC);
      expect(req.sequenceId).toBe(1);
      await req.accept();
      const active = JSON.parse(broker.retainedOn(activeTopic)!.toString()) as Array<{ status: string }>;
      expect(active).toHaveLength(1);
      await req.updateStatus({ status: 'EXECUTING' });
      await req.updateDetailStatus({ index: 0, status: 'EXECUTING', properties: { pct: 50 } });
      await req.complete({ status: 'SUCCEEDED' });
    });
    await inject(broker, body());
    await flush();
    expect(statuses(broker)).toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'EXECUTING', 'SUCCEEDED']);
    expect(JSON.parse(broker.retainedOn(activeTopic)!.toString())).toEqual([]);
  });

  it('reject(reason) publishes ABORTED with the reason', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    await handle.acceptRequests(RequestAcceptanceFilter.all(), (req) => void req.reject('REJECTED'));
    await inject(broker, body());
    await flush();
    const last = broker.messagesOn(statusTopic).at(-1)!.payload.toString();
    expect(statuses(broker)).toEqual(['RECEIVED', 'ABORTED']);
    expect(last).toContain('REJECTED');
  });

  it('rejects illegal transitions locally (Figure C.3)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    let error: unknown;
    await handle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      try { await req.updateStatus({ status: 'SUCCEEDED' }); } catch (e) { error = e; }
    });
    await inject(broker, body());
    await flush();
    expect(error).toBeInstanceOf(IllegalTransition);
    expect(statuses(broker)).toEqual(['RECEIVED']);
  });

  it('honours the acceptance filter and ignores duplicate retained replays', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    const seen: number[] = [];
    await handle.acceptRequests(RequestAcceptanceFilter.actions(['move']),
      (req) => seen.push(req.sequenceId));
    await inject(broker, body());
    await inject(broker, body());                                   // same (source, sequenceId)
    await inject(broker, body({ sequenceId: 2, details: [{ type: 'dock', version: '1.0', properties: {} }] }));
    expect(seen).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/coreAcceptRequests.test.ts`
Expected: FAIL — `acceptRequests` is not a function.

- [ ] **Step 3: Implement `IncomingRequest`**

```typescript
// src/core/incomingRequest.ts
import type { Uuid } from '../types/common.js';
import type { Request, RequestDetailStatus, RequestStatus } from '../types/requests.js';
import type { DetailState, RequestState } from '../types/constants.js';
import { DetailLifecycle, RequestLifecycle } from '../requests/stateMachine.js';
import { IllegalTransition } from '../errors.js';
import { toTimestamp, type RequestDetailStatusUpdate, type RequestStatusUpdate,
  type RequestTerminalUpdate, type StatusReason } from './types.js';

export interface StatusSink {
  /** Publishes one requestStatus message (QoS 2, retained) and refreshes activeRequestsStatus. */
  publishStatus(req: IncomingRequest, status: RequestStatus): Promise<void>;
  ownerUuid: Uuid;
  nextStatusSequenceId(): Promise<number>;
}

export class IncomingRequest {
  readonly #lifecycle = new RequestLifecycle();
  readonly #details: DetailLifecycle[];
  readonly #detailStatuses: RequestDetailStatus[];

  /** @internal */
  constructor(
    readonly request: Request,
    readonly requestUuid: Uuid,
    private readonly sink: StatusSink,
  ) {
    this.#details = request.details.map(() => new DetailLifecycle());
    this.#detailStatuses = request.details.map((d) => ({
      type: d.type,
      version: d.version,
      ...(d.blocking !== undefined ? { blocking: d.blocking } : {}),
      status: { code: 'RECEIVED' as DetailState },
    }));
  }

  get source(): Uuid { return this.request.source; }
  get sequenceId(): number { return this.request.sequenceId; }
  get state(): RequestState { return this.#lifecycle.state; }
  get isTerminal(): boolean { return this.#lifecycle.isTerminal(); }

  /** @internal — D-12: RECEIVED is published by the server before the handler sees this. */
  async publishReceived(): Promise<void> { await this.emit(); }

  async accept(): Promise<void> { await this.transitionTo('ACCEPTED'); }

  async reject(reason: StatusReason): Promise<void> {
    await this.transitionTo('ABORTED', reason);
  }

  async updateStatus(update: RequestStatusUpdate): Promise<void> {
    await this.transitionTo(update.status, update.reason, update.message);
  }

  async updateDetailStatus(update: RequestDetailStatusUpdate): Promise<void> {
    const lifecycle = this.#details[update.index];
    const entry = this.#detailStatuses[update.index];
    if (!lifecycle || !entry) {
      throw new IllegalTransition(`no request detail at index ${update.index}`);
    }
    if (lifecycle.state !== update.status) lifecycle.transition(update.status);
    entry.status = {
      code: update.status,
      ...(update.reason ? { reason: update.reason } : {}),
      ...(update.message ? { message: update.message } : {}),
    };
    if (update.properties) entry.properties = { ...entry.properties, ...update.properties };
    await this.emit();
  }

  async complete(terminal: RequestTerminalUpdate): Promise<void> {
    await this.transitionTo(terminal.status, terminal.reason, terminal.message);
  }

  /** @internal — used by the executor for the RECOVERY phase. */
  async enterRecovery(reason?: StatusReason): Promise<void> {
    await this.transitionTo('RECOVERY', reason);
  }

  private async transitionTo(
    to: RequestState, reason?: StatusReason, message?: string,
  ): Promise<void> {
    this.#lifecycle.transition(to);                      // throws IllegalTransition
    await this.emit(reason, message);
  }

  private async emit(reason?: StatusReason, message?: string): Promise<void> {
    const status: RequestStatus = {
      source: this.sink.ownerUuid,                       // decision 5
      destination: this.request.source,
      sequenceId: await this.sink.nextStatusSequenceId(),
      requestSequenceId: this.request.sequenceId,
      timestamp: toTimestamp(),
      status: this.#lifecycle.state,
      detailStatuses: this.#detailStatuses.map((d) => ({ ...d })),
    };
    if (reason || message) {
      const first = status.detailStatuses[0];
      if (first) {
        first.status = {
          ...first.status,
          ...(reason ? { reason } : {}),
          ...(message ? { message } : {}),
        };
      }
    }
    await this.sink.publishStatus(this, status);
  }
}
```

- [ ] **Step 4: Implement `RequestServer` and `EntityHandle.acceptRequests`**

`src/core/requestServer.ts` — one instance per `EntityHandle`, created lazily on the first
`acceptRequests`/`onRequest` call. Behavior, exactly:

1. **Subscription.** `session.subscribeTopic(`${topicFor(ref,'request')}/+`, null, …, { qos: 2 })` —
   `kind: null` because D-13 requires the server itself to see malformed payloads (a schema-routed
   subscription would divert them to `validation-warning` and no rejection would ever be published).
2. **Empty payload** (retained clear from a sender) → ignore.
3. **Parse + validate.** `JSON.parse` failure, or `validateMessage('request', …)` failure:
   if `source` and `sequenceId` can still be read as a string/number, publish a synthetic
   `ABORTED` + `MALFORMED_REQUEST` requestStatus on `<requestTopic>/status` (using an
   `IncomingRequest` built from a minimal request object with an empty `details` array) and count a
   rejection; otherwise emit a `validation-warning` and drop. Never call the app handler (D-13).
4. **Duplicate suppression.** Key `${source}:${sequenceId}`; a repeat is ignored with a
   `duplicate-request-ignored` diagnostic. `ponytail:` in-memory only — a process restart re-executes
   requests still retained on the broker; persist the key set alongside the sequence seed if that
   ever bites.
5. **RECEIVED.** Build the `IncomingRequest`, `await req.publishReceived()` (D-12), register it in
   the active map.
6. **Admission** (Task 6) then **hand-off**: registered `acceptRequests` handlers whose filter
   matches are invoked with the `IncomingRequest`; if no low-level handler matches and per-action
   handlers exist, the executor (Task 7) takes it; if neither exists, publish
   `ABORTED` + `ACTION_NOT_IMPLEMENTED`.
7. **`publishStatus(req, status)`** (the `StatusSink`): `session.publishTopic(<requestTopic>/status,
   'requestStatus', status, { qos: 2, retain: true })`, then republish
   `activeRequestsStatus` — the array of the latest status of every non-terminal request, via
   `session.publishResource(ref, 'activeRequestsStatus', 'requestStatusArray', array)` so the
   on-change guard suppresses no-op republishes. Terminal requests leave the active map first.
8. **`nextStatusSequenceId()`** draws from the same `SequenceCounter` as `sendRequest` — one
   monotonic stream per entity (D-15).

`EntityHandle.acceptRequests(filter, handler)` ensures the server, registers `{filter, handler}`,
and returns `composeSubscription([requestFilterTopic], [{ unsubscribe }])` that deregisters the
handler and tears the topic subscription down when the last one goes away.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/coreAcceptRequests.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: request serving substrate — IncomingRequest, auto-RECEIVED, auto-reject, activeRequestsStatus"
```

---

### Task 6: `ExecutionPolicy` interface and the C.2.2 presets

**Files:**
- Create: `src/core/policies.ts`
- Modify: `src/core/requestServer.ts`, `src/core/entityHandle.ts`, `src/core/client.ts`, `src/core/index.ts`
- Test: `test/corePolicies.test.ts`

**Interfaces:**
- Consumes: `Request`, `RequestStatus`, `StatusReason`.
- Produces:
  - `interface ExecutionPolicy { admit(pending: Request, active: readonly RequestStatus[]): AdmissionDecision }`
  - `type RequestKey = { source: Uuid; sequenceId: number }`
  - `type AdmissionDecision = { action: 'accept' } | { action: 'reject'; reason: StatusReason } | { action: 'buffer' } | { action: 'preempt'; preempt: readonly RequestKey[] }`
  - `const policies: { abortNew(): ExecutionPolicy; queueReplace(): ExecutionPolicy; queueAfter(): ExecutionPolicy; parallel(max?: number): ExecutionPolicy; priority(): ExecutionPolicy }`
  - `const DEFAULT_EXECUTION_POLICY: ExecutionPolicy` — `policies.parallel()` (**D-17**, parallel-capable)
  - `EntityHandle.setExecutionPolicy(policy)`, `Iso21423Client.setDefaultExecutionPolicy(policy)` (**P-2**)

Semantics (`active` = the latest status of every non-terminal request the entity is serving):

| Preset | Decision |
|---|---|
| `abortNew()` | any active request → `{ action: 'reject', reason: 'REJECTED' }`, else `accept` |
| `queueReplace()` | no active → `accept`; active and nothing buffered → `buffer`; active and one already buffered → `buffer` **and** the previously buffered request is aborted with `REJECTED` (the server keeps a one-slot buffer per entity) |
| `queueAfter()` | no active → `accept`, else `buffer` (unbounded FIFO, drained in arrival order) |
| `parallel(max = Infinity)` | `active.length < max` → `accept`, else `buffer` |
| `priority()` | `pending.priority ?? 100` (0 = highest) strictly lower than every active priority → `{ action: 'preempt', preempt: [all active keys] }`; equal or worse → `buffer`; no active → `accept`. Buffered requests drain in priority order, arrival order breaking ties |

The server applies the decision: `accept` → hand to the handler/executor; `reject` → publish `ABORTED` with the reason (the request never reaches app code); `buffer` → hold in the entity's pending queue and re-admit when an active request reaches a terminal state; `preempt` → cancel the named active requests (fire their `AbortSignal`s, ending them `CANCELED`), then accept the pending one.

- [ ] **Step 1: Write the failing test**

```typescript
// test/corePolicies.test.ts
import { describe, it, expect } from 'vitest';
import { policies, DEFAULT_EXECUTION_POLICY, nowTimestamp } from '../src/index.js';
import type { Request, RequestStatus } from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const req = (over: Partial<Request> = {}): Request => ({
  destination: B, source: A, sequenceId: 1, timestamp: nowTimestamp(),
  details: [{ type: 'move', version: '1.0', properties: {} }], ...over,
});

const active = (sequenceId: number, priority?: number): RequestStatus & { priority?: number } => ({
  source: B, destination: A, sequenceId, requestSequenceId: sequenceId,
  timestamp: nowTimestamp(), status: 'EXECUTING', detailStatuses: [],
  ...(priority !== undefined ? { priority } : {}),
});

describe('C.2.2 presets (D-17)', () => {
  it('abortNew rejects while anything is active', () => {
    const p = policies.abortNew();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'reject', reason: 'REJECTED' });
  });

  it('queueAfter buffers behind any active request', () => {
    const p = policies.queueAfter();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'buffer' });
  });

  it('queueReplace buffers and signals replacement of the queued slot', () => {
    const p = policies.queueReplace();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'buffer' });
  });

  it('parallel(max) accepts up to max concurrent requests', () => {
    const p = policies.parallel(2);
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1), active(2)])).toEqual({ action: 'buffer' });
    expect(policies.parallel().admit(req(), [active(1), active(2), active(3)]))
      .toEqual({ action: 'accept' });
  });

  it('priority preempts strictly lower-priority work and buffers otherwise', () => {
    const p = policies.priority();
    expect(p.admit(req({ priority: 10 }), [active(1, 100)]))
      .toEqual({ action: 'preempt', preempt: [{ source: B, sequenceId: 1 }] });
    expect(p.admit(req({ priority: 100 }), [active(1, 10)])).toEqual({ action: 'buffer' });
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
  });

  it('the default policy is parallel-capable (D-17)', () => {
    expect(DEFAULT_EXECUTION_POLICY.admit(req(), [active(1), active(2)]))
      .toEqual({ action: 'accept' });
  });

  it('accepts a custom policy implementing the interface', () => {
    const custom = {
      admit: (pending: Request) =>
        pending.details.some((d) => d.type === 'move')
          ? ({ action: 'accept' } as const)
          : ({ action: 'reject', reason: 'ACTION_NOT_IMPLEMENTED' } as const),
    };
    expect(custom.admit(req())).toEqual({ action: 'accept' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/corePolicies.test.ts`
Expected: FAIL — `policies` not exported.

- [ ] **Step 3: Implement the policies**

```typescript
// src/core/policies.ts
import type { Uuid } from '../types/common.js';
import type { Request, RequestStatus } from '../types/requests.js';
import type { StatusReason } from './types.js';

export interface RequestKey { source: Uuid; sequenceId: number }

export type AdmissionDecision =
  | { action: 'accept' }
  | { action: 'reject'; reason: StatusReason }
  | { action: 'buffer' }
  | { action: 'preempt'; preempt: readonly RequestKey[] };

/** Runtime admission strategy (D-17). Named C.2.2 strategies ship as presets below. */
export interface ExecutionPolicy {
  admit(pending: Request, active: readonly RequestStatus[]): AdmissionDecision;
}

const DEFAULT_PRIORITY = 100;                       // 0 high … 255 low (Table C.1)
const priorityOf = (r: { priority?: number }): number => r.priority ?? DEFAULT_PRIORITY;
const keyOf = (s: RequestStatus): RequestKey => ({ source: s.source, sequenceId: s.requestSequenceId });

export const policies = {
  abortNew(): ExecutionPolicy {
    return {
      admit: (_pending, active) =>
        active.length === 0 ? { action: 'accept' } : { action: 'reject', reason: 'REJECTED' },
    };
  },

  /** One active + one queued slot; the server aborts the displaced queue entry with REJECTED. */
  queueReplace(): ExecutionPolicy {
    return {
      admit: (_pending, active) => (active.length === 0 ? { action: 'accept' } : { action: 'buffer' }),
    };
  },

  queueAfter(): ExecutionPolicy {
    return {
      admit: (_pending, active) => (active.length === 0 ? { action: 'accept' } : { action: 'buffer' }),
    };
  },

  parallel(max = Number.POSITIVE_INFINITY): ExecutionPolicy {
    return {
      admit: (_pending, active) => (active.length < max ? { action: 'accept' } : { action: 'buffer' }),
    };
  },

  priority(): ExecutionPolicy {
    return {
      admit: (pending, active) => {
        if (active.length === 0) return { action: 'accept' };
        const mine = priorityOf(pending);
        const beatsAll = active.every(
          (s) => mine < priorityOf(s as RequestStatus & { priority?: number }));
        return beatsAll
          ? { action: 'preempt', preempt: active.map(keyOf) }
          : { action: 'buffer' };
      },
    };
  },
};

/** Parallel-capable default (D-17); overridable per client (P-2) and per handle. */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = policies.parallel();
```

`queueReplace` and `queueAfter` return the same decision; the difference lives in the server's
buffer, which `queueReplace` bounds to one slot. Implement that as a `bufferLimit` marker the
server reads: give the two presets a non-enumerable `bufferLimit` property (`1` for
`queueReplace`, `Infinity` for the rest) via `Object.assign(policyObject, { bufferLimit })`, and
type it as an optional field on `ExecutionPolicy`:

```typescript
export interface ExecutionPolicy {
  admit(pending: Request, active: readonly RequestStatus[]): AdmissionDecision;
  /** Optional hint: how many buffered requests to hold before displacing the oldest. */
  readonly bufferLimit?: number;
}
```

- [ ] **Step 4: Wire policies into the server**

- `Iso21423Client.setDefaultExecutionPolicy(policy)` stores the client default (initially
  `DEFAULT_EXECUTION_POLICY`); `EntityHandle.setExecutionPolicy(policy)` stores a per-handle
  override, and `EntityRegistration.executionPolicy` seeds it (**P-2**).
- `RequestServer` calls `policy.admit(request, activeStatuses)` after publishing `RECEIVED` and
  before any hand-off, where `activeStatuses` is the latest status of each non-terminal request.
- On `reject` → `req.reject(decision.reason)`; on `buffer` → push to the pending queue (displacing
  the oldest with `REJECTED` when `bufferLimit` is exceeded) and re-admit on every terminal
  transition; on `preempt` → cancel each named active request (Task 7's abort path; a request
  admitted through the low-level layer is ended `CANCELED` directly), then accept.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/corePolicies.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: ExecutionPolicy interface with C.2.2 presets and parallel-capable default"
```

---

### Task 7: Per-action executor — `EntityHandle.onRequest` (ND-11.1)

**Files:**
- Create: `src/core/executor.ts`
- Modify: `src/core/entityHandle.ts`, `src/core/requestServer.ts`, `src/core/index.ts`
- Test: `test/coreExecutor.test.ts`

**Interfaces:**
- Consumes: `IncomingRequest`, `RequestServer`, `ActionHandler`, `ActionContext`, `ActionResult`, `TypedRequestDetail`, `policies`.
- Produces:
  - `EntityHandle.onRequest<P>(type: string, handler: ActionHandler<P>, opts?: { override?: true }): void` — registering a second handler for the same type without `override: true` throws `Iso21423Error`
  - `class ActionExecutor` (internal) — detail sequencing, `atomic` protection, recovery, `cancelRequest` resolution, automatic reason codes

Behavior, exactly:

1. **Pre-flight rejection** (before `ACCEPTED`, request never reaches a handler), first match wins:
   - a detail whose `format` is set and is not `'ISO-21423'` → `ABORTED` + `FORMAT_NOT_SUPPORTED`;
   - a detail whose `version` major differs from `PROTOCOL_VERSION`'s major → `ABORTED` + `VERSION_NOT_SUPPORTED`;
   - a detail type with no registered handler and which is not `cancelRequest` → `ABORTED` + `ACTION_NOT_IMPLEMENTED`;
   - the entity's last published status contains `STOP_CATEGORY_0|1|2` or `WAIT_FOR_RESET` and the detail type is not `cancelRequest`/`pauseImr`/`resumeImr` → `ABORTED` + `INVALID_IMR_STATE_FOR_ACTION` (decision 7).
2. **`cancelRequest` resolution** — handled by the executor, never by an app handler (**ND-11.1**).
   Look up the active request by `(properties.source, properties.requestId)`. Found → fire its
   `AbortController`, mark it cancel-requested, and finish the cancel request itself `SUCCEEDED`.
   Not found → `ABORTED` + `REJECTED`. Inbound `type: 'cancel'` is normalized to `cancelRequest`
   with a `legacy-cancel-normalized` diagnostic (**D-02**).
3. **Sequencing.** `ACCEPTED` → `EXECUTING`, then walk the details in order: a maximal run of
   consecutive `blocking: false` details runs concurrently (`Promise.all`); every `blocking: true`
   detail (the default) runs alone, in order. Each detail publishes `EXECUTING` on start and its
   terminal detail status on finish.
4. **Atomic protection.** A detail with `atomic: true` (or the request-level `atomic: true`) does not
   receive an abort signal once it is executing: its `ctx.signal` is never fired, the cancel is
   remembered, and it takes effect after that detail settles. Details not yet started are marked
   `CANCELED`.
5. **Handler outcomes.** `ctx.succeeded(props?)` → detail `SUCCEEDED` (props merged into the detail
   status `properties`); `ctx.aborted(reason, msg?)` → detail `ABORTED` with that reason; a thrown
   error → detail `ABORTED` + `GENERAL_FAILURE` with `error.message` (never propagates to the event
   loop). `ctx.progress(props)` publishes a detail status update in state `EXECUTING`.
6. **Recovery.** On abort or cancel with `request.recoveries` present: transition the request to
   `RECOVERY`, run the recovery details with the same sequencing rules and report them in
   `recoveryStatuses`. Final state: `CANCELED` when the trigger was a cancel, otherwise `ABORTED`
   (decision 8, **NP-2**); a failed recovery keeps `ABORTED` and carries the recovery's reason. With
   no recoveries, the request goes straight to `ABORTED`/`CANCELED`.
7. **Success.** All details `SUCCEEDED` → request `SUCCEEDED`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/coreExecutor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Iso21423Client, cancelRequest, move, nowTimestamp, pauseImr } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };

async function pair(broker: MemoryBroker) {
  const robotClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null,
  });
  const robot = await robotClient.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move', 'pauseImr', 'cancelRequest'] },
  });
  const senderClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
  });
  const sender = await senderClient.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  await flush();
  return { robot, sender };
}

const statusesFor = (broker: MemoryBroker, requestUuid: string) =>
  broker.messagesOn(`/ISO_21423/v1/IMR/${DST}/request/${requestUuid}/status`)
    .map((m) => JSON.parse(m.payload.toString()) as {
      status: string;
      detailStatuses: Array<{ type: string; status: { code: string; reason?: string } }>;
      recoveryStatuses?: Array<{ status: { code: string } }>;
    });

describe('per-action executor (ND-11.1)', () => {
  it('drives RECEIVED → ACCEPTED → EXECUTING → SUCCEEDED around the handler', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (action, ctx) => {
      expect(action.properties).toMatchObject(target);
      expect(ctx.entity.entityUuid).toBe(DST);
      ctx.progress({ distanceRemaining: 3 });
      return ctx.succeeded({ arrived: true });
    });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await req.completion();
    expect(statusesFor(broker, req.requestUuid).map((s) => s.status))
      .toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'EXECUTING', 'EXECUTING', 'SUCCEEDED']);
  });

  it('rejects unknown actions with ACTION_NOT_IMPLEMENTED before ACCEPTED', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ type: 'teleport', version: '1.0', properties: {} }],
    });
    await expect(req.completion()).rejects.toThrow(/ABORTED/);
    const last = statusesFor(broker, req.requestUuid).at(-1)!;
    expect(last.status).toBe('ABORTED');
    expect(last.detailStatuses[0]!.status.reason).toBe('ACTION_NOT_IMPLEMENTED');
  });

  it('rejects unsupported versions and formats', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const bad = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ ...move(target), version: '2.0' }],
    });
    await expect(bad.completion()).rejects.toThrow();
    expect(statusesFor(broker, bad.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('VERSION_NOT_SUPPORTED');

    const wrongFormat = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ ...move(target), format: 'VENDOR-X' }],
    });
    await expect(wrongFormat.completion()).rejects.toThrow();
    expect(statusesFor(broker, wrongFormat.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('FORMAT_NOT_SUPPORTED');
  });

  it('rejects with INVALID_IMR_STATE_FOR_ACTION while the robot is stopped (decision 7)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    await robot.publishStatus({ states: ['MODE_AUTO', 'STOP_CATEGORY_0'] });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await expect(req.completion()).rejects.toThrow();
    expect(statusesFor(broker, req.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('INVALID_IMR_STATE_FOR_ACTION');
  });

  it('runs blocking details serially and consecutive non-blocking details concurrently', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    const order: string[] = [];
    const gate = { release: () => {} };
    const blocked = new Promise<void>((r) => { gate.release = r; });
    robot.onRequest('move', async (_a, ctx) => { order.push('move-start'); await blocked; order.push('move-end'); return ctx.succeeded(); });
    robot.onRequest('pauseImr', async (_a, ctx) => { order.push('pause'); return ctx.succeeded(); });
    const req = await sender.sendRequest({
      destination: DST,
      details: [move(target), { ...pauseImr(), blocking: false }, { ...move(target), blocking: false }],
    });
    await flush();
    expect(order).toEqual(['move-start']);         // blocking detail holds the queue
    gate.release();
    await req.completion();
    expect(order).toEqual(['move-start', 'move-end', 'pause', 'move-start', 'move-end']);
  });

  it('cancelRequest fires the target AbortSignal and ends it CANCELED', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    let aborted = false;
    robot.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      aborted = true;
      return ctx.aborted('OK', 'canceled by request');
    });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow(/CANCELED/);
    expect(aborted).toBe(true);
    expect(statusesFor(broker, req.requestUuid).at(-1)!.status).toBe('CANCELED');
  });

  it('does not abort an atomic detail mid-flight (C.2.3)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    let finishedNormally = false;
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    robot.onRequest('move', async (_a, ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      await held;
      finishedNormally = !ctx.signal.aborted;
      return ctx.succeeded();
    });
    const req = await sender.sendRequest({
      destination: DST, details: [{ ...move(target), atomic: true }],
    });
    await flush();
    await req.cancel();
    await flush();
    release();
    await req.completion().catch(() => undefined);
    expect(finishedNormally).toBe(true);
  });

  it('runs recoveries after an abort and still ends ABORTED (decision 8 / NP-2)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    const ran: string[] = [];
    robot.onRequest('move', async (_a, ctx) => { ran.push('move'); return ctx.aborted('GENERAL_FAILURE', 'wheel slip'); });
    robot.onRequest('pauseImr', async (_a, ctx) => { ran.push('recovery'); return ctx.succeeded(); });
    const req = await sender.sendRequest({
      destination: DST, details: [move(target)], recoveries: [pauseImr()],
    });
    await expect(req.completion()).rejects.toThrow();
    const seq = statusesFor(broker, req.requestUuid).map((s) => s.status);
    expect(ran).toEqual(['move', 'recovery']);
    expect(seq).toContain('RECOVERY');
    expect(seq.at(-1)).toBe('ABORTED');
    expect(statusesFor(broker, req.requestUuid).at(-1)!.recoveryStatuses![0]!.status.code)
      .toBe('SUCCEEDED');
  });

  it('maps a thrown handler error to ABORTED + GENERAL_FAILURE', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async () => { throw new Error('driver crashed'); });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await expect(req.completion()).rejects.toThrow();
    const last = statusesFor(broker, req.requestUuid).at(-1)!;
    expect(last.status).toBe('ABORTED');
    expect(last.detailStatuses[0]!.status.reason).toBe('GENERAL_FAILURE');
  });

  it('refuses to replace a handler without override: true', async () => {
    const broker = new MemoryBroker();
    const { robot } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    expect(() => robot.onRequest('move', async (_a, ctx) => ctx.succeeded())).toThrow(/override/);
    expect(() => robot.onRequest('move', async (_a, ctx) => ctx.succeeded(), { override: true }))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/coreExecutor.test.ts`
Expected: FAIL — `onRequest` is not a function.

- [ ] **Step 3: Implement `src/core/executor.ts`**

Structure (the plumbing is fixed by the behavior list and the tests above):

```typescript
// src/core/executor.ts — shape of the executor's per-request run
interface ActiveRun {
  incoming: IncomingRequest;
  controller: AbortController;
  cancelRequested: boolean;      // set when a cancelRequest arrived while an atomic detail ran
  atomicInFlight: boolean;
}

export class ActionExecutor {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly runs = new Map<string, ActiveRun>();   // key `${source}:${sequenceId}`

  register(type: string, handler: ActionHandler, opts?: { override?: true }): void { /* … */ }

  /** Entry point called by RequestServer once a request is admitted. */
  async run(incoming: IncomingRequest, entity: EntityHandle): Promise<void> { /* … */ }

  /** Called by the policy preempt path and by cancelRequest resolution. */
  cancel(key: RequestKey): boolean { /* fires the AbortController; false when unknown */ }
}
```

Implementation notes that the tests pin:
- `ctx` is built per detail: `signal` comes from the run's `AbortController` unless the detail is
  atomic (then a never-fired detached `AbortController().signal`); `progress(props)` calls
  `incoming.updateDetailStatus({ index, status: 'EXECUTING', properties: props })`;
  `succeeded`/`aborted` are pure constructors of `ActionResult`.
- `run()` awaits each blocking detail and `Promise.all`s each non-blocking run; after every detail
  it checks `controller.signal.aborted || cancelRequested` and, if set, marks the remaining details
  `CANCELED` and jumps to the recovery/terminal path.
- `cancelRequest` details are intercepted in `RequestServer` before `run()` so they can resolve
  against `runs` even when the entity is otherwise busy; the cancel request itself never enters the
  policy buffer.
- Register the executor as the fallback consumer in `RequestServer` step 6 (Task 5): low-level
  `acceptRequests` handlers win when their filter matches; otherwise, if any `onRequest` handler is
  registered, the executor runs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/coreExecutor.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: per-action request executor with detail sequencing, atomic protection and recovery"
```

---

### Task 8: `FleetGateway` facade — janitor, dispatch, publish self-check

**Files:**
- Create: `src/gateway/fleetGateway.ts`, `src/gateway/janitor.ts`, `src/gateway/selfCheck.ts`, `src/gateway/index.ts`
- Modify: `src/core/client.ts` (expose the self-check helper for `security.selfCheck`), `src/index.ts`
- Test: `test/gateway.test.ts`

**Interfaces:**
- Consumes: the whole `/core` surface.
- Produces:
  - `class FleetGateway`:
    - `static connect(opts: FleetGatewayOptions): Promise<FleetGateway>`
    - `readonly client: Iso21423Client`, `readonly imrfm: EntityHandle`
    - `registerImr(reg: ImrRegistration): Promise<EntityHandle>`
    - `unregisterImr(id: Uuid): Promise<void>`
    - `imrs(): EntityHandle[]`
    - `onRequest<P>(type: string, handler: ActionHandler<P>, opts?: { imr?: Uuid; override?: true }): void`
    - `onDispatch(cb: (request: Request, imrs: EntityHandle[]) => Uuid | null): void`
    - `close(opts?: { timeout?: number }): Promise<void>`
  - `interface FleetGatewayOptions { transport?: MqttTransport; url?: string; security?: SecurityOptions; imrfm: { id: Uuid; manufacturerName: string; details?: Record<string, unknown>; accepts?: string[]; provides?: string[] }; janitor?: { enabled?: boolean; graceMs?: number }; validateOutbound?: boolean; sequenceStore?: SequenceStore | null; requestTimeoutMs?: number }`
  - `interface ImrRegistration { id: Uuid; identity?: Record<string, unknown>; manufacturerName?: string; accepts?: string[]; provides?: string[]; executionPolicy?: ExecutionPolicy }`
  - `async function publishSelfCheck(session, ref, timeoutMs): Promise<void>` — throws `AuthorizationDenied` when the identity echo does not come back (**ND-15**)
  - `class RetainedRequestJanitor` — `note(topic: string)` on terminal status, clears after `graceMs` (**ND-10**)

- [ ] **Step 1: Write the failing test**

```typescript
// test/gateway.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  FleetGateway, Iso21423Client, AuthorizationDenied, move, nowTimestamp, policies,
} from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const FLEET = '42177726-26f7-4f5c-b735-a12a427bb96d';
const IMR_A = '91403a21-7534-4467-99a6-79c46a130fe8';
const IMR_B = '11111111-1111-4111-8111-111111111111';
const SRC = '33333333-3333-4333-8333-333333333333';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const ns = (t: string, u: string, r: string) => `/ISO_21423/v1/${t}/${u}/${r}`;

async function gateway(broker: MemoryBroker, over: Record<string, unknown> = {}) {
  return FleetGateway.connect({
    transport: broker.createTransport(),
    sequenceStore: null,
    imrfm: { id: FLEET, manufacturerName: 'Acme Fleet', accepts: ['move'] },
    janitor: { graceMs: 5 },
    ...over,
  });
}

async function requester(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
  });
  return c.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
}

describe('FleetGateway', () => {
  it('registers the IMRFM and managed robots with manages/managedBy links (D-11)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    const a = await g.registerImr({ id: IMR_A, manufacturerName: 'Acme Robotics', accepts: ['move'] });
    const b = await g.registerImr({ id: IMR_B, manufacturerName: 'Acme Robotics', accepts: ['move'] });
    expect(g.imrs().map((h) => h.entityUuid)).toEqual([IMR_A, IMR_B]);
    expect(a.ownershipMode).toBe('managed');
    const fleetIdentity = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET, 'identity'))!.toString()) as {
      capabilities: { manages: string[] };
    };
    expect(fleetIdentity.capabilities.manages).toEqual([IMR_A, IMR_B]);
    expect(JSON.parse(broker.retainedOn(ns('IMR', IMR_B, 'identity'))!.toString()))
      .toMatchObject({ capabilities: { managedBy: FLEET } });
    void b;
  });

  it('serves fleet-wide handlers with per-robot overrides', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    g.onRequest('move', async (_a, ctx) => { served.push(`fleet:${ctx.entity.entityUuid}`); return ctx.succeeded(); });
    g.onRequest('move', async (_a, ctx) => { served.push(`a-only:${ctx.entity.entityUuid}`); return ctx.succeeded(); }, { imr: IMR_A });
    const sender = await requester(broker);
    await flush();
    await (await sender.sendRequest({ destination: IMR_A, details: [move(target)] })).completion();
    await (await sender.sendRequest({ destination: IMR_B, details: [move(target)] })).completion();
    expect(served).toEqual([`a-only:${IMR_A}`, `fleet:${IMR_B}`]);
  });

  it('dispatches empty-destination requests through the callback (ND-12)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    g.onRequest('move', async (_a, ctx) => { served.push(ctx.entity.entityUuid); return ctx.succeeded(); });
    g.onDispatch((_req, imrs) => imrs[1]!.entityUuid);
    const sender = await requester(broker);
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    await req.completion();
    expect(served).toEqual([IMR_B]);
  });

  it('rejects empty-destination requests when no callback is registered (ND-12)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const sender = await requester(broker);
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    await expect(req.completion()).rejects.toThrow();
    const status = JSON.parse(
      broker.messagesUnder(`/ISO_21423/v1/IMRFM/${FLEET}/request/`).at(-1)!.payload.toString(),
    ) as { status: string; detailStatuses: Array<{ status: { reason?: string } }> };
    expect(status.status).toBe('ABORTED');
    expect(status.detailStatuses[0]!.status.reason).toBe('REJECTED');
  });

  it('the janitor clears a retained request a crashed sender left behind (ND-10)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker, { janitor: { graceMs: 5 } });
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());

    // A "crashed" sender: publishes the retained request itself and never cleans it up.
    const rogue = broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    const requestUuid = 'aa53a1e1-782f-479b-88b3-fd110198be45';
    const topic = ns('IMR', IMR_A, `request/${requestUuid}`);
    await rogue.publish(topic, JSON.stringify({
      destination: IMR_A, source: SRC, sequenceId: 9, timestamp: nowTimestamp(),
      details: [move(target)],
    }), { qos: 2, retain: true });
    await flush();
    expect(broker.retainedOn(topic)).toBeDefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(broker.retainedOn(topic)).toBeUndefined();
  });

  it('fails startup when the broker silently drops the identity publish (ND-15 self-check)', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe(ns('IMRFM', FLEET, 'identity'));
    await expect(gateway(broker, { security: { selfCheck: true, selfCheckTimeoutMs: 20 } }))
      .rejects.toThrow(AuthorizationDenied);
  });

  it('unregisterImr drops the manages link and clears the robot topics', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    await g.unregisterImr(IMR_B);
    expect(g.imrs().map((h) => h.entityUuid)).toEqual([IMR_A]);
    expect(broker.retainedOn(ns('IMR', IMR_B, 'identity'))).toBeUndefined();
    const fleetIdentity = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET, 'identity'))!.toString()) as {
      capabilities: { manages: string[] };
    };
    expect(fleetIdentity.capabilities.manages).toEqual([IMR_A]);
  });

  it('exposes the underlying client for policies and direct core use (P-2)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    const a = await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.client.setDefaultExecutionPolicy(policies.parallel());
    a.setExecutionPolicy(policies.queueAfter());
    expect(g.imrfm.entityType).toBe('IMRFM');
    expect(typeof g.client.health).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gateway.test.ts`
Expected: FAIL — `FleetGateway` not exported.

- [ ] **Step 3: Implement the self-check and the janitor**

```typescript
// src/gateway/selfCheck.ts
import type { Iso21423Session } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import { AuthorizationDenied } from '../errors.js';

/**
 * ND-15: MQTT 3.1.1 gives no negative acknowledgement for a denied publish, so the only way to
 * detect a missing write grant is to read our own retained identity back.
 */
export async function publishSelfCheck(
  session: Iso21423Session, ref: EntityRef, timeoutMs = 2000,
): Promise<void> {
  const topic = session.topicFor(ref, 'identity');
  let seen = false;
  let resolveEcho: () => void = () => {};
  const echo = new Promise<void>((resolve) => { resolveEcho = resolve; });
  const sub = await session.subscribeTopic(topic, null, (raw) => {
    if (typeof raw === 'string' && raw.length > 0) { seen = true; resolveEcho(); }
  }, { qos: 1 });
  try {
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    });
    await Promise.race([echo, timer]);
    if (!seen) {
      throw new AuthorizationDenied(
        `publish self-check failed: no retained identity echo on ${topic} — the broker ACL ` +
        `probably denies write access to this namespace (ND-15)`, topic);
    }
  } finally {
    await sub.unsubscribe();
  }
}
```

```typescript
// src/gateway/janitor.ts
import type { Iso21423Session } from '../session/session.js';

/**
 * ND-10: the sender clears its own retained request at terminal state. The gateway additionally
 * clears requests in its own namespaces that are still retained a grace period after the terminal
 * status it published — protection against crashed senders. Clearing an already-cleared topic is a
 * harmless no-op, so no "is it still retained?" probe is needed.
 */
export class RetainedRequestJanitor {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly session: Iso21423Session,
    private readonly graceMs: number,
    private readonly onCleared: (topic: string) => void,
  ) {}

  note(requestTopic: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.session.clearRetained(requestTopic).then(() => this.onCleared(requestTopic));
    }, this.graceMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
```

The janitor is fed from two places: every terminal status the gateway's own `RequestServer`s
publish, **and** every request seen on an owned `request/+` topic that never produced a terminal
status within the grace period (the crashed-sender case in the test — the request is served,
completed and cleared by the gateway; the extra clear is idempotent). Implement it by calling
`janitor.note(requestTopic)` from `RequestServer` whenever it publishes a terminal status **and**
whenever it ignores a duplicate or unroutable retained request.

- [ ] **Step 4: Implement `FleetGateway`**

Behavior, exactly:

- `connect(opts)`: build an `Iso21423Client` (transport or url), then `client.registerSelfEntity({
  entityUuid: opts.imrfm.id, entityType: 'IMRFM', manufacturerName, details, capabilities:
  { provides: opts.imrfm.provides ?? [], accepts: opts.imrfm.accepts ?? [] } })` — the **first**
  operation on the client, so the B.4 will is armed (decision 1). Then run `publishSelfCheck` when
  `security.selfCheck !== false` (**gateway default: on**, **ND-15**), start the janitor when
  `janitor.enabled !== false` (`graceMs` default `30_000`), and register the empty-destination
  interceptor on the IMRFM handle.
- `registerImr(reg)`: `client.registerManagedEntity(imrfmUuid, { entityUuid: reg.id, entityType:
  'IMR', manufacturerName: reg.manufacturerName ?? <IMRFM's>, details: reg.identity, capabilities:
  { accepts: reg.accepts ?? [], provides: reg.provides ?? [] }, executionPolicy: reg.executionPolicy })`,
  run the self-check for the robot namespace when enabled, replay every fleet-wide `onRequest`
  handler onto the new handle, and remember it in insertion order. Returns a `Promise<EntityHandle>`
  — see the review notes; `nodejs_api.md` §11 sketches it non-awaited, but registration performs I/O
  (identity publish, `manages` republish, self-check) whose failures must not be swallowed.
- `unregisterImr(id)`: `await handle.unregister()`, drop it from the list, and republish the IMRFM
  identity with the shortened `manages` array.
- `onRequest(type, handler, opts)`: with `opts.imr` → register on that handle only (override
  semantics apply per handle); without → store as fleet-wide (applied to every current and future
  managed handle, and to the IMRFM handle itself so requests addressed to the fleet manager are
  served too).
- `onDispatch(cb)`: store the callback. The IMRFM's `RequestServer` intercepts any request whose
  `destination` is `''` **before** admission: with a callback, call `cb(request, this.imrs())`; a
  returned uuid that matches a managed handle re-targets execution to that handle's executor while
  the status stream stays on the topic the request arrived on; `null`, no callback, or an unknown
  uuid → `ABORTED` + `REJECTED` plus a `dispatch-rejected` diagnostic (**ND-12**).
- `close(opts)`: dispose the janitor, then `client.close(opts)` (graceful; the will is suppressed).
  Managed handles are **not** unregistered — a fleet restart should not erase the fleet's retained
  state; call `unregisterImr` explicitly for that.

```typescript
// src/gateway/index.ts
export * from './fleetGateway.js';
export { publishSelfCheck } from './selfCheck.js';
export { RetainedRequestJanitor } from './janitor.js';
```

Add to `src/index.ts`:

```typescript
export * from './gateway/index.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/gateway.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: FleetGateway facade with dispatch callback, retained-request janitor and publish self-check"
```

---

### Task 9: Broker-free integration suite (`testing_strategy.md` §2)

**Files:**
- Create: `test/integration/harness.ts`, `test/integration/requestLifecycles.test.ts`, `test/integration/executionPolicies.test.ts`, `test/integration/servingLayers.test.ts`, `test/integration/managedEntities.test.ts`, `test/integration/sessionRules.test.ts`, `test/integration/observerSurface.test.ts`
- Modify: `package.json` (add `test:integration`), `vitest.config.ts` (include `test/**/*.test.ts` already covers the subdirectory — verify)
- Test: the files above are the tests

**Interfaces:**
- Consumes: the complete public surface from Tasks 1–8 plus `MemoryBroker`.
- Produces: `test/integration/harness.ts` exporting
  - `function deployment(): { broker: MemoryBroker; client(opts?): Promise<Iso21423Client>; gateway(opts): Promise<FleetGateway> }` — every client bound to one shared in-memory broker, `sequenceStore: null`, `requestTimeoutMs: 500`
  - `async function flush(times = 6): Promise<void>` — drains the microtask/immediate queue
  - `async function waitFor(pred: () => boolean, opts?: { timeoutMs?: number; label?: string }): Promise<void>` — polls on `setImmediate` up to 1 s, throwing `` `waitFor timed out: ${label}` ``
  - `function statusSequence(broker, entityType, entityUuid, requestUuid): string[]` — the ordered `status` values published on a request's status topic
  - `function detailReasons(broker, …): Array<string | undefined>` — reasons from the last status message

These tests run against `MemoryTransport` only — **no broker, no network, on every commit**
(`testing_strategy.md` §2). Nothing here may import `mqtt`.

- [ ] **Step 1: Write the harness**

```typescript
// test/integration/harness.ts
import { FleetGateway, Iso21423Client } from '../../src/index.js';
import { MemoryBroker } from '../../src/testing/index.js';

export const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
export const target = (x = 1, y = 2) => ({ location: { ccsId: CCS, x, y, z: 0 } });

export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

export async function waitFor(
  pred: () => boolean, opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 1000);
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
    await new Promise((r) => setImmediate(r));
  }
}

export function deployment() {
  const broker = new MemoryBroker();
  return {
    broker,
    async client(over: Record<string, unknown> = {}) {
      return Iso21423Client.connect({
        transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500, ...over,
      });
    },
    async gateway(imrfm: { id: string; manufacturerName: string; accepts?: string[] },
                  over: Record<string, unknown> = {}) {
      return FleetGateway.connect({
        transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
        security: { selfCheck: false }, janitor: { graceMs: 10 }, imrfm, ...over,
      });
    },
  };
}

export function statusSequence(
  broker: MemoryBroker, entityType: string, entityUuid: string, requestUuid: string,
): string[] {
  return broker
    .messagesOn(`/ISO_21423/v1/${entityType}/${entityUuid}/request/${requestUuid}/status`)
    .map((m) => (JSON.parse(m.payload.toString()) as { status: string }).status);
}

export function lastStatus(
  broker: MemoryBroker, entityType: string, entityUuid: string, requestUuid: string,
): {
  status: string;
  detailStatuses: Array<{ type: string; status: { code: string; reason?: string } }>;
  recoveryStatuses?: Array<{ type: string; status: { code: string; reason?: string } }>;
} {
  const msgs = broker.messagesOn(
    `/ISO_21423/v1/${entityType}/${entityUuid}/request/${requestUuid}/status`);
  return JSON.parse(msgs.at(-1)!.payload.toString()) as never;
}
```

- [ ] **Step 2: Write the request-lifecycle suite**

`test/integration/requestLifecycles.test.ts` — one `describe` per case, all through
`sender.sendRequest(...)` against a robot registered on the same broker. Required cases and the
exact observable wire outcome each asserts:

| Case | Assertion on the wire |
|---|---|
| Multi-detail happy path | status sequence `RECEIVED, ACCEPTED, EXECUTING…, SUCCEEDED`; every `detailStatuses[i].status.code === 'SUCCEEDED'`; `completion()` resolves |
| Cancel mid-execution | target's handler observes `ctx.signal` firing; last status `CANCELED`; unstarted details `CANCELED`; `completion()` rejects `RequestFailed` |
| Cancel of an `atomic` detail | the atomic handler's `ctx.signal.aborted` stays `false` until it returns; the cancel takes effect only afterwards; last status `CANCELED` |
| Recovery after abort | statuses contain `RECOVERY`; `recoveryStatuses[0].status.code === 'SUCCEEDED'`; last status `ABORTED` (decision 8) |
| Failed recovery | `recoveryStatuses[0].status.code === 'ABORTED'`; last status `ABORTED`; reason from the recovery detail |
| Recovery after cancel | last status `CANCELED` with recoveries reported |
| Blocking vs non-blocking | handler start/end order proves serial blocking details and concurrent consecutive non-blocking ones |
| `ACTION_NOT_IMPLEMENTED` | no handler registered → last status `ABORTED`, `detailStatuses[0].status.reason === 'ACTION_NOT_IMPLEMENTED'`, handler never called |
| `MALFORMED_REQUEST` | raw transport publishes a schema-invalid request → `ABORTED` + `MALFORMED_REQUEST`, no handler call (**D-13**) |
| `VERSION_NOT_SUPPORTED` | detail `version: '2.0'` → `ABORTED` + `VERSION_NOT_SUPPORTED` |
| `FORMAT_NOT_SUPPORTED` | detail `format: 'VENDOR-X'` → `ABORTED` + `FORMAT_NOT_SUPPORTED` |
| `INVALID_IMR_STATE_FOR_ACTION` | robot status `['MODE_AUTO','STOP_CATEGORY_0']` → `ABORTED` + `INVALID_IMR_STATE_FOR_ACTION` |
| `RequestTimeout` | destination with no server → `completion()` rejects `RequestTimeout` and **no** status message exists on the wire (**D-14**) |

Write the happy path and the cancel case in full as the pattern for the rest:

```typescript
// test/integration/requestLifecycles.test.ts
import { describe, it, expect } from 'vitest';
import { move, pauseImr } from '../../src/index.js';
import { deployment, flush, lastStatus, statusSequence, target } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';

async function scene() {
  const d = deployment();
  const robotClient = await d.client();
  const robot = await robotClient.registerSelfEntity({
    entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move', 'pauseImr', 'cancelRequest'] },
  });
  const senderClient = await d.client();
  const sender = await senderClient.registerSelfEntity({
    entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  await flush();
  return { ...d, robot, sender };
}

describe('multi-detail happy path', () => {
  it('reports every detail SUCCEEDED and resolves completion()', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target()), pauseImr()],
    });
    const final = await req.completion();
    expect(final.status).toBe('SUCCEEDED');
    const seq = statusSequence(broker, 'IMR', ROBOT, req.requestUuid);
    expect(seq[0]).toBe('RECEIVED');
    expect(seq[1]).toBe('ACCEPTED');
    expect(seq.at(-1)).toBe('SUCCEEDED');
    expect(lastStatus(broker, 'IMR', ROBOT, req.requestUuid).detailStatuses.map((d) => d.status.code))
      .toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });
});

describe('cancel mid-execution', () => {
  it('fires the handler AbortSignal and ends CANCELED', async () => {
    const { broker, robot, sender } = await scene();
    let sawAbort = false;
    robot.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      sawAbort = true;
      return ctx.aborted('OK', 'canceled');
    });
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target()), pauseImr()],
    });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow();
    expect(sawAbort).toBe(true);
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('CANCELED');
    expect(final.detailStatuses[1]!.status.code).toBe('CANCELED');   // never started
  });
});
```

- [ ] **Step 3: Write the execution-policy suite**

`test/integration/executionPolicies.test.ts` — two senders interleaving requests against one robot
(**D-17**, **P-2**). Cases:

- `abortNew()` — second request while the first executes → its last status `ABORTED` + `REJECTED`, the first still finishes `SUCCEEDED`.
- `queueAfter()` — second request buffers: no `ACCEPTED` for it until the first is `SUCCEEDED`, then it runs; handler start order equals arrival order.
- `queueReplace()` — three overlapping requests: the middle one ends `ABORTED` + `REJECTED` (displaced from the one-slot buffer), the third runs after the first.
- `parallel(2)` — three overlapping requests: two run concurrently (both reach `EXECUTING` before either finishes), the third buffers.
- `priority()` — a `priority: 10` request preempts an executing `priority: 100` one (the latter's handler sees its signal fire and ends `CANCELED`), then the high-priority one runs.
- Client default vs per-handle override (**P-2**): `client.setDefaultExecutionPolicy(policies.abortNew())` with `handleB.setExecutionPolicy(policies.parallel())` — B accepts concurrent requests while A rejects them.

Pattern for each: register a `move` handler that blocks on a released promise, send request 1,
`await flush()`, send request 2, assert on `statusSequence(...)` of both, then release and drain.

- [ ] **Step 4: Write the serving-layer suite**

`test/integration/servingLayers.test.ts` (**ND-11**):
- per-action layer and `acceptRequests` on the **same** handle: a request matching a low-level
  filter goes to `acceptRequests`, one that doesn't goes to the executor;
- `IncomingRequest` driving a full lifecycle by hand (`accept` → `updateStatus('EXECUTING')` →
  `updateDetailStatus` → `complete('SUCCEEDED')`) with the wire sequence asserted;
- illegal transition: calling `complete({status:'SUCCEEDED'})` straight from `RECEIVED` throws
  `IllegalTransition` and publishes nothing beyond `RECEIVED`;
- `RECEIVED` is on the wire before any handler runs (**D-12**), asserted from inside the handler;
- schema-invalid inbound never reaches either layer and is auto-rejected (**D-13**).

- [ ] **Step 5: Write the managed-entity suite**

`test/integration/managedEntities.test.ts`:
- publishing through a managed handle lands under the **robot's** namespace, not the IMRFM's;
- `manages`/`managedBy` links appear on both retained identities and survive `unregisterImr`;
- direct-to-robot routing (request published to `IMR/<uuid>/request/…`) and via-IMRFM routing
  (`IMRFM/<fleet>/request/…` with an explicit `destination` uuid) both execute, and each publishes
  its status on the topic the request arrived on;
- empty-destination dispatch with a callback selects a robot; with no callback the request is
  `ABORTED` + `REJECTED` (**ND-12**).

- [ ] **Step 6: Write the session-rule suite**

`test/integration/sessionRules.test.ts` (**ND-08**, **ND-10**) — behavior, not internals:
- status published only on change: three `publishStatus` calls with two distinct payloads produce two wire messages;
- rate-gate clamping: 50 `publishOdometry` calls in a tight loop produce far fewer wire messages than 50 and never exceed the Table B.1 bound (use `vi.useFakeTimers()` and advance in 1/30 s steps, asserting one message per interval);
- sender-side retained-request cleanup on terminal status (retained topic empty afterwards);
- gateway janitor clears a request a crashed sender left retained (grace 10 ms);
- stale retained `disconnection` cleared on connect;
- reconnect republish: `transport.dropConnection()` → the owned retained resources appear a second time on the wire;
- graceful `close()` does **not** fire the will.

- [ ] **Step 7: Write the observer suite**

`test/integration/observerSurface.test.ts`:
- each `EntityFilter` builder compiles to exactly the expected MQTT filters, asserted through
  `broker.subscriptions()` after a `subscribeResource` call;
- lazy subscribe/unsubscribe (**ND-17**): two subscriptions on the same filter produce one broker
  subscription; unsubscribing one keeps it, unsubscribing both removes it;
- `await using` disposes a subscription at scope exit (**D-19**);
- `discover()` builds the catalog from retained identities only, including the `manages` graph, a
  late-joining entity appearing without resubscribing, and `lost` flipping on the retained LWT
  (**D-18**);
- `subscribeRequests` / `subscribeRequestStatus` see third-party traffic addressed to other
  entities.

- [ ] **Step 8: Add the script and run the whole suite**

In `package.json` scripts: `"test:integration": "vitest run test/integration"`.

Run: `npm run test:integration && npm test && npm run typecheck && npm run lint`
Expected: PASS with no network access — confirm by running with the loopback-only sandbox or by
asserting no test imports `mqtt`: `! grep -rn "from 'mqtt'" test/integration`.

- [ ] **Step 9: Commit**

```bash
git add src test package.json
git commit -m "test: broker-free integration suite for lifecycles, policies, serving layers, session rules and observers"
```

---

### Task 10: Subpath exports, CI, and GitHub Packages publishing

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `.github/mosquitto/mosquitto.conf`, `src/types/index.ts` re-export check
- Modify: `package.json`, `tsup.config.ts`, `README.md` (repo root pointer optional), `ts-sdk/README.md`
- Test: `test/packaging.test.ts`

**Interfaces:**
- Consumes: every module built in Tasks 1–9.
- Produces: the published package layout of `nodejs_api.md` §2 and the CI/publish pipeline of
  `oro_integration.md` §3.

- [ ] **Step 1: Write the failing packaging test**

```typescript
// test/packaging.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

const SUBPATHS = ['.', './types', './schema', './topics', './geometry', './session', './core',
  './gateway', './testing'];

describe('package layout (nodejs_api.md §2, ND-19)', () => {
  it('declares every documented subpath with CJS, ESM and types', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; import: string; require: string }>;
      peerDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    for (const sub of SUBPATHS) {
      expect(Object.keys(pkg.exports)).toContain(sub);
      const entry = pkg.exports[sub]!;
      expect(entry.types.endsWith('.d.ts')).toBe(true);
      expect(entry.import.endsWith('.js')).toBe(true);
      expect(entry.require.endsWith('.cjs')).toBe(true);
    }
    expect(pkg.peerDependencies.mqtt).toBe('^5.0.0');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ajv', 'ajv-formats', 'uuid']);
  });

  it('keeps the root entry free of top-level await (CJS constraint)', async () => {
    const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*await /m);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/packaging.test.ts`
Expected: FAIL — only `.` and `./testing` are declared.

- [ ] **Step 3: Add subpath entries to the build**

`src/types/index.ts`, `src/schema/index.ts`, `src/topics/index.ts`, `src/geometry/index.ts`,
`src/session/index.ts`, `src/core/index.ts`, `src/gateway/index.ts`, `src/testing/index.ts` already
exist as barrels; add them as tsup entries:

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types/index.ts',
    schema: 'src/schema/index.ts',
    topics: 'src/topics/index.ts',
    geometry: 'src/geometry/index.ts',
    session: 'src/session/index.ts',
    core: 'src/core/index.ts',
    gateway: 'src/gateway/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  sourcemap: true,
  clean: true,
});
```

and the matching `exports` map in `package.json` (one entry per subpath, `types`/`import`/`require`
pointing at `./dist/<name>.d.ts`, `./dist/<name>.js`, `./dist/<name>.cjs`; keep `"."` first):

```json
  "exports": {
    ".":          { "types": "./dist/index.d.ts",    "import": "./dist/index.js",    "require": "./dist/index.cjs" },
    "./types":    { "types": "./dist/types.d.ts",    "import": "./dist/types.js",    "require": "./dist/types.cjs" },
    "./schema":   { "types": "./dist/schema.d.ts",   "import": "./dist/schema.js",   "require": "./dist/schema.cjs" },
    "./topics":   { "types": "./dist/topics.d.ts",   "import": "./dist/topics.js",   "require": "./dist/topics.cjs" },
    "./geometry": { "types": "./dist/geometry.d.ts", "import": "./dist/geometry.js", "require": "./dist/geometry.cjs" },
    "./session":  { "types": "./dist/session.d.ts",  "import": "./dist/session.js",  "require": "./dist/session.cjs" },
    "./core":     { "types": "./dist/core.d.ts",     "import": "./dist/core.js",     "require": "./dist/core.cjs" },
    "./gateway":  { "types": "./dist/gateway.d.ts",  "import": "./dist/gateway.js",  "require": "./dist/gateway.cjs" },
    "./testing":  { "types": "./dist/testing.d.ts",  "import": "./dist/testing.js",  "require": "./dist/testing.cjs" }
  }
```

- [ ] **Step 4: Verify the built package from both module systems**

Run:
```bash
npm run build
node -e "const g=require('./dist/gateway.cjs'); const c=require('./dist/core.cjs'); console.log(typeof g.FleetGateway.connect, typeof c.Iso21423Client.connect, typeof c.policies.parallel)"
node --input-type=module -e "import { FleetGateway } from './dist/gateway.js'; import { Iso21423Client, EntityFilter } from './dist/core.js'; console.log(typeof FleetGateway.connect, typeof Iso21423Client.connect, EntityFilter.all().topicFiltersFor('status')[0])"
node -e "const s=require('./dist/index.cjs'); console.log(typeof s.FleetGateway, typeof s.Iso21423Client, typeof s.MemoryBroker)"
```
Expected: `function function function`; `function function /ISO_21423/v1/+/+/status`; and
`function function undefined` — the root entry must **not** export the testing fakes.

- [ ] **Step 5: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

defaults:
  run:
    working-directory: ts-sdk

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ts-sdk/.nvmrc
          cache: npm
          cache-dependency-path: ts-sdk/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: CommonJS consumability (ORO constraint)
        run: node -e "const s=require('./dist/index.cjs'); if (typeof s.Iso21423Client.connect !== 'function') process.exit(1)"
      - name: ESM consumability
        run: node --input-type=module -e "import { FleetGateway } from './dist/gateway.js'; if (typeof FleetGateway.connect !== 'function') process.exit(1)"

  # Optional smoke test against a real broker. Not required for merge: the conformance/e2e suite
  # is Plan 3 (testing_strategy.md §3). Runs nightly and on demand.
  live-broker:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ts-sdk/.nvmrc
          cache: npm
          cache-dependency-path: ts-sdk/package-lock.json
      - name: Start Mosquitto
        run: |
          docker run -d --name mosquitto -p 1883:1883 \
            -v "$GITHUB_WORKSPACE/.github/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf" \
            eclipse-mosquitto:2
        working-directory: .
      - run: npm ci
      - run: npm run test:live
        env:
          ISO21423_BROKER_URL: mqtt://127.0.0.1:1883
```

Add the trigger block `schedule: [{ cron: '0 3 * * *' }]` and `workflow_dispatch:` to `on:`, plus:

```
# .github/mosquitto/mosquitto.conf
listener 1883 0.0.0.0
allow_anonymous true
```

and a `test:live` script (`"test:live": "vitest run test/live"`) with a single smoke test
`test/live/roundTrip.test.ts` that skips itself when `ISO21423_BROKER_URL` is unset: connect two
clients through `createMqttTransport`, register an IMR, send a `move`, assert `SUCCEEDED`. This is
the only test in the repo allowed to touch the network, it is never part of `npm test`, and the job
is `continue-on-error` — the required signal stays the broker-free suite.

- [ ] **Step 6: Write the publish workflow**

```yaml
# .github/workflows/publish.yml
name: Publish

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  packages: write

defaults:
  run:
    working-directory: ts-sdk

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ts-sdk/.nvmrc
          cache: npm
          cache-dependency-path: ts-sdk/package-lock.json
          registry-url: https://npm.pkg.github.com
          scope: '@openrobops'
      - run: npm ci
      - name: Tag must match package.json version
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG="$(node -p "require('./package.json').version")"
          test "$TAG" = "$PKG" || { echo "tag $TAG != package version $PKG"; exit 1; }
      - run: npm test
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 7: Document consumption from GitHub Packages**

Append to `ts-sdk/README.md` (phase 1 registry, `oro_integration.md` §3):

````markdown
## Installing (GitHub Packages)

The package is published to GitHub Packages under `@openrobops`. Consumers add a scope mapping:

```ini
# .npmrc
@openrobops:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` — required even for public packages. Then:

```sh
npm install @openrobops/iso21423 mqtt
```

`mqtt@^5` is a peer dependency: install it alongside, or inject your own `MqttTransport`.
Public npmjs publication is phase 2, at API stability (**ND-19**).
````

- [ ] **Step 8: Run the full verification**

Run: `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npx vitest run test/packaging.test.ts`
Expected: everything PASS; `dist/` contains `index`, `types`, `schema`, `topics`, `geometry`,
`session`, `core`, `gateway`, `testing` in `.js`, `.cjs` and `.d.ts` form.

- [ ] **Step 9: Commit**

```bash
git add package.json tsup.config.ts src test README.md ../.github
git commit -m "ci: subpath exports, GitHub Actions build/test pipeline and GitHub Packages publishing"
```

---

## Out of scope for this plan (later plans)

- **Plan 3 — Examples + e2e:** `examples/imr-simulator`, `examples/imrfm-gateway-template`,
  `examples/fleet-observer`, `examples/facility-sandbox`, and the data-driven `ScenarioRunner`
  conformance/interop harness against real brokers (Mosquitto + EMQX profiles) —
  `testing_strategy.md` §3–4, `deliverables.md`. The optional live-broker CI job added in Task 10 is
  a smoke test, not that suite.
- **Plan 4 — ORO bridge:** the `oro/ingest/src/server/iso21423/` adapter — `FleetBackend`
  implementation over ORO internals, CCS calibration from Mongo settings, `mqtt_credentials` ACL
  provisioning, `settings.json` configuration (`oro_integration.md` §2), in the `oro` repository.
- Deferred design items that stay open after this plan: **NP-1** (transport-level correlation
  metadata), **NP-2** (state-machine table reconciliation — the four disputed transitions remain
  flagged in code), **NP-3** (final `EntityFilter` builder surface), **NP-4** (conformance-runner
  packaging).
