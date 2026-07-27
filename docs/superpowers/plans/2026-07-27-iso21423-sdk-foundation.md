# ISO 21423 SDK Foundation Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the protocol-primitive layers of `@openrobops/iso21423` — types, topics, schema validation, CCS geometry, request state machine, in-memory test transport, and the conformant MQTT session — fully unit-tested.

**Architecture:** Layered library per the approved spec (`docs/superpowers/specs/2026-07-27-iso21423-sdk-design.md`): `types` → `topics`/`schema`/`geometry` → `session`, with an `MqttTransport` interface isolating the `mqtt` package and a `MemoryTransport` fake enabling broker-free tests. The `gateway`/`client` facades are Plan 2; examples/e2e are Plan 3; the ORO bridge is Plan 4.

**Tech Stack:** TypeScript 5, Node ≥22, tsup (dual CJS+ESM+d.ts), vitest, ajv + ajv-formats, uuid, mqtt v5 (peer dependency).

**Repo:** this repository (`iso21423/`, future `openrobops/iso21423`). Source under `src/`, tests under `test/`.

## Global Constraints

- Package name `@openrobops/iso21423`, license `Apache-2.0`, `engines.node >= 22`.
- Runtime deps ONLY: `ajv`, `ajv-formats`, `uuid`. `mqtt@^5.0.0` is a **peerDependency** (also a devDependency for tests).
- Dual build: ESM + CJS + bundled `.d.ts` via tsup, target `es2022`. No top-level await anywhere in `src/`.
- Topic root namespace is exactly `/ISO_21423/v1` (leading slash, per B.2.1).
- Timestamps: always **emit** dot-decimal ISO 8601 (`YYYY-MM-DDThh:mm:ss.fffZ`); **parse** both dot and comma (spec §3.1).
- Wire-format resolution rules are spec §3.1: schema names win (`entityId`, `states`, `activeRequestsStatus`, `requestId`), EXCEPT `destination` accepts `""` (patched schema) and `knots` are `number[]`.
- Session rules (spec §4): `cleanSession: false`, keep-alive 60 s, LWT = topic `<ns>/<entityType>/<uuid>/disconnection`, QoS 1, retained, payload `{"states":["LOST_CONNECTION"]}`.
- Enums are open: known values as const arrays + `| string` union types. Validators warn, not reject, on unknown values.
- Every commit message uses conventional commits (`feat:`, `test:`, `chore:`).

---

### Task 1: Package scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `src/index.ts`, `src/testing/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a building, testing package skeleton. Later tasks add files under `src/` and re-export from `src/index.ts`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@openrobops/iso21423",
  "version": "0.1.0",
  "description": "TypeScript SDK implementing ISO 21423 — Industrial mobile robots: communications and interoperability (MQTT + JSON)",
  "license": "Apache-2.0",
  "repository": "github:openrobops/iso21423",
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "engines": { "node": ">=22" },
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./testing": { "types": "./dist/testing.d.ts", "import": "./dist/testing.js", "require": "./dist/testing.cjs" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": { "mqtt": "^5.0.0" },
  "dependencies": {
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "mqtt": "^5.15.0",
    "tsup": "^8.4.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write tsup.config.ts and vitest.config.ts**

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  sourcemap: true,
  clean: true,
});
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

```gitignore
# .gitignore
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 4: Write placeholder entries and smoke test**

```typescript
// src/index.ts
export const SDK_NAME = '@openrobops/iso21423';
```

```typescript
// src/testing/index.ts
export {};
```

```typescript
// test/smoke.test.ts
import { describe, it, expect } from 'vitest';
import { SDK_NAME } from '../src/index.js';

describe('package skeleton', () => {
  it('exposes the package entry', () => {
    expect(SDK_NAME).toBe('@openrobops/iso21423');
  });
});
```

- [ ] **Step 5: Install, test, build — all must succeed**

Run: `npm install && npm test && npm run build`
Expected: 1 test passes; `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/testing.cjs` exist.

- [ ] **Step 6: Verify CJS consumability (ORO constraint)**

Run: `node -e "const sdk = require('./dist/index.cjs'); if (sdk.SDK_NAME !== '@openrobops/iso21423') process.exit(1); console.log('CJS OK')"`
Expected: prints `CJS OK`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore src test
git commit -m "chore: scaffold @openrobops/iso21423 package (dual CJS+ESM build, vitest)"
```

---

### Task 2: Core types, constants, timestamps, errors

**Files:**
- Create: `src/types/common.ts`, `src/types/constants.ts`, `src/types/identity.ts`, `src/types/status.ts`, `src/types/telemetry.ts`, `src/types/requests.ts`, `src/types/actions.ts`, `src/types/ccs.ts`, `src/types/index.ts`, `src/errors.ts`
- Modify: `src/index.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `Uuid`, `IsoTimestamp`, `nowTimestamp(date?: Date): IsoTimestamp`, `parseTimestamp(ts: string): Date`
  - `EntityIdentity`, `Capabilities`, `ImrDetails`, `ImrfmDetails`, `EntityStatus`, `Odometry`, `LocationPoint`, `Orientation`, `BatteryStatus`, `LocalTrajectory`, `GlobalPath`, `NurbsCurve`, `GlobalPlan`, `Point`
  - `Request`, `RequestDetail`, `RequestStatus`, `RequestDetailStatus`, `RequestState`, `DetailState`, `ReasonCode`
  - Action builders: `move(props: MoveProps): RequestDetail`, `pauseImr()`, `resumeImr()`, `cancel(props: CancelProps)`, `dock(props: DockProps)`, `undock()`
  - `Ccs`, `ReferencePoint`
  - Errors: `Iso21423Error`, `ValidationError`, `RequestFailed`, `RequestTimeout`, `BrokerUnavailable`, `AuthorizationDenied`, `NotCapableError`, `IllegalTransition`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/types.test.ts
import { describe, it, expect } from 'vitest';
import {
  nowTimestamp, parseTimestamp,
  KNOWN_OPERATING_STATES, REQUEST_STATES,
  move, pauseImr, cancel, dock,
} from '../src/index.js';
import { ValidationError, Iso21423Error } from '../src/index.js';

describe('timestamps', () => {
  it('emits dot-decimal ISO 8601 with milliseconds', () => {
    const ts = nowTimestamp(new Date('2025-04-08T12:34:56.789Z'));
    expect(ts).toBe('2025-04-08T12:34:56.789Z');
  });
  it('parses dot-decimal timestamps', () => {
    expect(parseTimestamp('2025-04-08T12:34:56.789Z').getTime())
      .toBe(Date.UTC(2025, 3, 8, 12, 34, 56, 789));
  });
  it('parses comma-decimal timestamps (clause-table form, spec §3.1)', () => {
    expect(parseTimestamp('2024-01-11T12:58:19,050Z').getTime())
      .toBe(Date.UTC(2024, 0, 11, 12, 58, 19, 50));
  });
});

describe('constants', () => {
  it('includes the Table 5 operating states and modes', () => {
    for (const s of ['STOP_CATEGORY_0', 'LOST', 'CHARGING', 'IDLE', 'PARKED', 'MODE_AUTO', 'MODE_MAINTENANCE']) {
      expect(KNOWN_OPERATING_STATES).toContain(s);
    }
  });
  it('includes the Table C.6 request states', () => {
    expect(REQUEST_STATES).toEqual(
      ['RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED', 'RECOVERY']);
  });
});

describe('action builders', () => {
  it('builds a move detail with defaults', () => {
    const d = move({ location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 } });
    expect(d).toEqual({
      type: 'move',
      version: '1.0',
      format: 'ISO-21423',
      blocking: true,
      atomic: false,
      properties: { location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 } },
    });
  });
  it('builds pauseImr with empty properties', () => {
    expect(pauseImr().type).toBe('pauseImr');
    expect(pauseImr().properties).toEqual({});
  });
  it('builds cancel with requestId (Table C.4 name, not the example\'s "id")', () => {
    const d = cancel({ source: '42177726-26f7-4f5c-b735-a12a427bb96d', requestId: 42 });
    expect(d.properties).toEqual({ source: '42177726-26f7-4f5c-b735-a12a427bb96d', requestId: 42 });
  });
  it('builds dock with dockActions', () => {
    const d = dock({
      dockLocation: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 1, y: 2, z: 0 },
      dockActions: ['CHARGE'],
    });
    expect(d.type).toBe('dock');
    expect((d.properties as { dockActions?: string[] }).dockActions).toEqual(['CHARGE']);
  });
});

describe('errors', () => {
  it('ValidationError extends Iso21423Error extends Error', () => {
    const e = new ValidationError('bad payload', []);
    expect(e).toBeInstanceOf(Iso21423Error);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ValidationError');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — modules/exports not found.

- [ ] **Step 3: Implement common.ts, constants.ts, errors.ts**

```typescript
// src/types/common.ts
export type Uuid = string;
/** ISO 8601-1 timestamp string, dot-decimal milliseconds, UTC. */
export type IsoTimestamp = string;

export function nowTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString();
}

/** Accepts both dot and comma decimal separators (spec §3.1). */
export function parseTimestamp(ts: string): Date {
  return new Date(ts.replace(',', '.'));
}
```

```typescript
// src/types/constants.ts
export const ROOT_NAMESPACE = '/ISO_21423/v1';
export const PROTOCOL_VERSION = '1.0';

export const ENTITY_TYPES = ['IMR', 'IMRFM'] as const;
export type KnownEntityType = (typeof ENTITY_TYPES)[number];
export type EntityType = KnownEntityType | (string & {});

export const KNOWN_OPERATING_STATES = [
  'STOP_CATEGORY_0', 'STOP_CATEGORY_1', 'STOP_CATEGORY_2',
  'PAUSED', 'WAIT_FOR_RESET', 'MAPPING', 'LOST',
  'WAIT_FOR_ATTACHMENT', 'WAIT_FOR_EVENT', 'BLOCKED', 'ATTACHMENT_ACTIVE',
  'STOPPED', 'DOCKING', 'SLOWING', 'ACCELERATING',
  'LEFT_TURN', 'RIGHT_TURN', 'REVERSE', 'FORWARD', 'LINE_FOLLOWING',
  'CHARGING', 'LOW_BATTERY', 'IDLE', 'PARKED', 'OFFLINE',
  'READY', 'NOT_READY',
  'MODE_AUTO', 'MODE_SEMIAUTO', 'MODE_TELEOP', 'MODE_MANUAL', 'MODE_MAINTENANCE',
] as const;
export type KnownOperatingState = (typeof KNOWN_OPERATING_STATES)[number];
export type OperatingState = KnownOperatingState | (string & {});

export const OPERATING_MODES = [
  'MODE_AUTO', 'MODE_SEMIAUTO', 'MODE_TELEOP', 'MODE_MANUAL', 'MODE_MAINTENANCE',
] as const;

/** LWT state published by the broker on ungraceful disconnect (B.4). */
export const LOST_CONNECTION_STATE = 'LOST_CONNECTION';

export const REQUEST_STATES = [
  'RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED', 'RECOVERY',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const DETAIL_STATES = [
  'RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED',
] as const;
export type DetailState = (typeof DETAIL_STATES)[number];

export const KNOWN_REASON_CODES = [
  'OK', 'GENERAL_FAILURE', 'TIMEOUT', 'VERSION_NOT_SUPPORTED', 'FORMAT_NOT_SUPPORTED',
  'ACTION_NOT_IMPLEMENTED', 'REJECTED', 'MALFORMED_REQUEST', 'INVALID_IMR_STATE_FOR_ACTION',
] as const;
export type ReasonCode = (typeof KNOWN_REASON_CODES)[number] | (string & {});

export const BATTERY_HEALTH = [
  'UNKNOWN', 'HEALTHY', 'OVERHEAT', 'DEAD', 'OVERVOLTAGE', 'FAILURE', 'COLD',
] as const;
export type BatteryHealth = (typeof BATTERY_HEALTH)[number] | (string & {});

export const CHARGING_STATES = [
  'UNKNOWN', 'CHARGING', 'DISCHARGING', 'NOT_CHARGING', 'FULL',
] as const;
export type ChargingState = (typeof CHARGING_STATES)[number] | (string & {});

export const DOCK_ACTIONS = ['CHARGE', 'DUMP', 'FILL', 'LOAD', 'UNLOAD', 'PICK', 'DROP'] as const;
export type DockAction = (typeof DOCK_ACTIONS)[number] | (string & {});
```

```typescript
// src/errors.ts
export class Iso21423Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends Iso21423Error {
  constructor(message: string, public readonly errors: unknown[]) {
    super(message);
  }
}

export class RequestFailed extends Iso21423Error {
  constructor(message: string, public readonly finalStatus: unknown) {
    super(message);
  }
}

export class RequestTimeout extends Iso21423Error {}
export class BrokerUnavailable extends Iso21423Error {}

export class AuthorizationDenied extends Iso21423Error {
  constructor(message: string, public readonly topic: string) {
    super(message);
  }
}

export class NotCapableError extends Iso21423Error {}
export class IllegalTransition extends Iso21423Error {}
```

- [ ] **Step 4: Implement the message type modules**

```typescript
// src/types/ccs.ts
import type { Uuid } from './common.js';

export interface Point { x: number; y: number }

export interface Ccs { id: Uuid; name: string; referencePointIds: Uuid[] }

export interface ReferencePoint { id: Uuid; name: string; x: number; y: number }

export interface LocationPoint { ccsId: Uuid; x: number; y: number; z: number }

export interface Orientation { yaw: number; pitch: number; roll: number }
```

```typescript
// src/types/identity.ts
import type { Uuid, IsoTimestamp } from './common.js';
import type { EntityType } from './constants.js';
import type { Point } from './ccs.js';

export interface Capabilities {
  provides: string[];
  accepts: { requests: string[] };
  manages?: Uuid[];
  managedBy?: Uuid;
}

export interface SoftwareVersion { moduleName: string; moduleVersion: string }

export interface AdditionalProperty { key: string; value: string }

export interface SupportVendorContactInformation {
  name: string; phone?: string; address?: string; email?: string;
}

export interface ImrDetails {
  imrModel: string;
  imrSerialNumber: string;
  imrName?: string;                     // schema/example field, spec §3.1 (B2 in defects doc)
  imrFootprint: Point[];
  imrWorkingArea: Point[];
  imrHeight: number;
  softwareVersions: SoftwareVersion[];
  priority?: number;
  ratedSpeed?: number;
  supportedChargerTypes?: string[];
  supportVendorName?: string;
  supportVendorContactInformation?: string;
  visualThumbnailImage?: string;
  ratedLoad?: number;
  supportURL?: string;
  imrDocumentation?: string;
  payloadTypes?: string[];
  batteryType?: string;
  additionalProperties?: AdditionalProperty[];
}

export interface ImrfmDetails {
  softwareVersions: SoftwareVersion[];
  imrfmModel?: string;
  supportVendorContactInf?: SupportVendorContactInformation;
  supportURL?: string;
  imrfmDocumentation?: string;
}

export interface EntityIdentity {
  id: Uuid;
  timestamp: IsoTimestamp;
  entityType: EntityType;
  manufacturerName: string;
  iso21423Version?: string;
  capabilities: Capabilities;
  details: ImrDetails | ImrfmDetails | Record<string, unknown>;
}
```

```typescript
// src/types/status.ts
import type { Uuid, IsoTimestamp } from './common.js';
import type { OperatingState } from './constants.js';
import type { Capabilities } from './identity.js';

export interface EntityStatus {
  entityId: Uuid;                      // schema name; clause tables say "id" (spec §3.1)
  timestamp: IsoTimestamp;
  states: OperatingState[];            // mode first, then states by priority
  disabledCapabilities?: Capabilities;
}
```

```typescript
// src/types/telemetry.ts
import type { IsoTimestamp } from './common.js';
import type { BatteryHealth, ChargingState } from './constants.js';
import type { LocationPoint, Orientation } from './ccs.js';

export interface Odometry {
  timestamp: IsoTimestamp;
  pose: { locationPoint: LocationPoint; orientation: Orientation };
  velocity: { linear: number; angular: number };
}

export interface BatteryStatus {
  timestamp: IsoTimestamp;
  batterySoc: number;                  // 0..1
  batteryHealth?: BatteryHealth;
  batteryTemperature?: number;
  batteryVoltage?: number;
  batteryCurrent?: number;
  batteryChargingState?: ChargingState;
}

export interface LocationPointStamped { timestamp: IsoTimestamp; locationPoint: LocationPoint }

export interface LocalTrajectory { timestamp: IsoTimestamp; localTrajectory: LocationPointStamped[] }

export interface NurbsControlPoint { locationPoint: LocationPoint; weight?: number }

export interface NurbsCurve { degree: number; controlPoints: NurbsControlPoint[]; knots: number[] }

export interface GlobalPath { timestamp: IsoTimestamp; globalPath: NurbsCurve }

export interface GlobalPlan { timestamp: IsoTimestamp; globalPlan: LocationPointStamped[] }
```

```typescript
// src/types/requests.ts
import type { Uuid, IsoTimestamp } from './common.js';
import type { RequestState, DetailState, ReasonCode } from './constants.js';

export interface RequestDetail {
  type: string;
  version: string;
  format?: string;                     // default "ISO-21423"
  blocking?: boolean;                  // default true
  atomic?: boolean;                    // default false
  properties?: Record<string, unknown>;
}

export interface Request {
  destination: Uuid | '';              // "" → IMRFM picks the robot (spec §3.1)
  source: Uuid;
  sequenceId: number;
  timestamp: IsoTimestamp;
  priority?: number;                   // 0 high … 255 low, default 100
  atomic?: boolean;
  details: RequestDetail[];
  recoveries?: RequestDetail[];
}

export interface DetailStatusBody {
  code: DetailState;
  reason?: ReasonCode;
  message?: string;
  [vendor: string]: unknown;
}

export interface RequestDetailStatus {
  type: string;
  version: string;
  blocking?: boolean;
  status: DetailStatusBody;
  properties?: Record<string, unknown>;
}

export interface RequestStatus {
  source: Uuid;
  destination: Uuid;
  sequenceId: number;
  requestSequenceId: number;
  timestamp: IsoTimestamp;
  status: RequestState;
  detailStatuses: RequestDetailStatus[];
  recoveryStatuses?: RequestDetailStatus[];
}
```

```typescript
// src/types/actions.ts
import { PROTOCOL_VERSION, type DockAction } from './constants.js';
import type { Uuid } from './common.js';
import type { LocationPoint, Orientation } from './ccs.js';
import type { RequestDetail } from './requests.js';

export interface OrientationTolerance { yaw: number; pitch: number; roll: number }

export interface MoveProps {
  location: LocationPoint;
  orientation?: Orientation;           // in examples but not Table C.3 (spec §3.1)
  toleranceRadius?: number;
  orientationTolerance?: OrientationTolerance;
  arrivalTime?: string;
}

export interface CancelProps { source: Uuid; requestId: number; actionId?: number }

export interface DockProps {
  dockLocation: LocationPoint;
  dockId?: Uuid;
  dockActions?: DockAction[];
  toleranceRadius?: number;
  orientationTolerance?: OrientationTolerance;
}

interface BuilderOpts { blocking?: boolean; atomic?: boolean; version?: string }

function detail(type: string, properties: Record<string, unknown>, opts: BuilderOpts = {}): RequestDetail {
  return {
    type,
    version: opts.version ?? PROTOCOL_VERSION,
    format: 'ISO-21423',
    blocking: opts.blocking ?? true,
    atomic: opts.atomic ?? false,
    properties,
  };
}

export const move = (props: MoveProps, opts?: BuilderOpts): RequestDetail =>
  detail('move', { ...props }, opts);
export const pauseImr = (opts?: BuilderOpts): RequestDetail => detail('pauseImr', {}, opts);
export const resumeImr = (opts?: BuilderOpts): RequestDetail => detail('resumeImr', {}, opts);
export const cancel = (props: CancelProps, opts?: BuilderOpts): RequestDetail =>
  detail('cancel', { ...props }, opts);
export const dock = (props: DockProps, opts?: BuilderOpts): RequestDetail =>
  detail('dock', { ...props }, opts);
export const undock = (opts?: BuilderOpts): RequestDetail => detail('undock', {}, opts);
```

```typescript
// src/types/index.ts
export * from './common.js';
export * from './constants.js';
export * from './ccs.js';
export * from './identity.js';
export * from './status.js';
export * from './telemetry.js';
export * from './requests.js';
export * from './actions.js';
```

```typescript
// src/index.ts (replace content)
export * from './types/index.js';
export * from './errors.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/types.test.ts && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: core types, constants, timestamp utils, error classes"
```

---

### Task 3: Topics module (builder, parser, Table B.1 resource registry)

**Files:**
- Create: `src/topics/topics.ts`, `src/topics/resources.ts`, `src/topics/index.ts`
- Modify: `src/index.ts`
- Test: `test/topics.test.ts`

**Interfaces:**
- Consumes: `ROOT_NAMESPACE`, `Uuid`, `EntityType` from Task 2.
- Produces:
  - `interface EntityRef { entityType: string; entityUuid: string }`
  - `topicFor(ref: EntityRef, resource: string): string`
  - `requestTopic(ref: EntityRef, requestUuid: string): string`
  - `requestStatusTopic(ref: EntityRef, requestUuid: string): string`
  - `disconnectionTopic(ref: EntityRef): string`
  - `parseTopic(topic: string): ParsedTopic | null` where `ParsedTopic = { entityType: string; entityUuid: string; resource: string; requestUuid?: string; isRequestStatus: boolean }`
  - `identityWildcard(): string` → `/ISO_21423/v1/+/+/identity`
  - `topicFilterMatches(filter: string, topic: string): boolean` (MQTT `+`/`#` semantics)
  - `RESOURCE_CONFIG: Record<string, ResourceConfig>` with `ResourceConfig = { qos: 0 | 1 | 2; retain: boolean; minHz?: number; maxHz?: number }`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/topics.test.ts
import { describe, it, expect } from 'vitest';
import {
  topicFor, requestTopic, requestStatusTopic, disconnectionTopic,
  parseTopic, identityWildcard, topicFilterMatches, RESOURCE_CONFIG,
} from '../src/index.js';

const ref = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';

describe('topic builder', () => {
  it('builds resource topics under the B.2.1 layout', () => {
    expect(topicFor(ref, 'odometry'))
      .toBe('/ISO_21423/v1/IMR/91403a21-7534-4467-99a6-79c46a130fe8/odometry');
  });
  it('builds request and request-status topics (with entityType — defect A6 fix)', () => {
    expect(requestTopic(ref, REQ))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}`);
    expect(requestStatusTopic(ref, REQ))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}/status`);
  });
  it('builds the disconnection (LWT) topic', () => {
    expect(disconnectionTopic(ref))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/disconnection`);
  });
  it('exposes the discovery wildcard', () => {
    expect(identityWildcard()).toBe('/ISO_21423/v1/+/+/identity');
  });
});

describe('topic parser', () => {
  it('parses a simple resource topic', () => {
    expect(parseTopic(`/ISO_21423/v1/IMRFM/${REQ}/status`))
      .toEqual({ entityType: 'IMRFM', entityUuid: REQ, resource: 'status', isRequestStatus: false });
  });
  it('parses request and request-status topics', () => {
    expect(parseTopic(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}`))
      .toEqual({ entityType: 'IMR', entityUuid: ref.entityUuid, resource: 'request', requestUuid: REQ, isRequestStatus: false });
    expect(parseTopic(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}/status`))
      .toEqual({ entityType: 'IMR', entityUuid: ref.entityUuid, resource: 'request', requestUuid: REQ, isRequestStatus: true });
  });
  it('returns null for foreign topics', () => {
    expect(parseTopic('ros/rosbag/upload')).toBeNull();
    expect(parseTopic('/ISO_21423/v2/IMR/x/status')).toBeNull();
  });
});

describe('topicFilterMatches', () => {
  it('matches + and # wildcards with leading-slash topics', () => {
    expect(topicFilterMatches('/ISO_21423/v1/+/+/identity', `/ISO_21423/v1/IMR/${REQ}/identity`)).toBe(true);
    expect(topicFilterMatches(`/ISO_21423/v1/IMR/${REQ}/#`, `/ISO_21423/v1/IMR/${REQ}/request/x/status`)).toBe(true);
    expect(topicFilterMatches('/ISO_21423/v1/+/+/identity', `/ISO_21423/v1/IMR/${REQ}/odometry`)).toBe(false);
  });
});

describe('RESOURCE_CONFIG (Table B.1)', () => {
  it('assigns normative QoS and retain per resource', () => {
    expect(RESOURCE_CONFIG.identity).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.status).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.batteryStatus).toEqual({ qos: 0, retain: true });
    expect(RESOURCE_CONFIG.odometry).toEqual({ qos: 0, retain: false, minHz: 0.5, maxHz: 30 });
    expect(RESOURCE_CONFIG.localTrajectory).toEqual({ qos: 0, retain: false, minHz: 1, maxHz: 10 });
    expect(RESOURCE_CONFIG.request).toEqual({ qos: 2, retain: true });
    expect(RESOURCE_CONFIG.requestStatus).toEqual({ qos: 2, retain: true });
    expect(RESOURCE_CONFIG.activeRequestsStatus).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.disconnection).toEqual({ qos: 1, retain: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/topics.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement**

```typescript
// src/topics/topics.ts
import { ROOT_NAMESPACE } from '../types/constants.js';

export interface EntityRef { entityType: string; entityUuid: string }

export interface ParsedTopic {
  entityType: string;
  entityUuid: string;
  resource: string;
  requestUuid?: string;
  isRequestStatus: boolean;
}

export function topicFor(ref: EntityRef, resource: string): string {
  return `${ROOT_NAMESPACE}/${ref.entityType}/${ref.entityUuid}/${resource}`;
}

export function requestTopic(ref: EntityRef, requestUuid: string): string {
  return `${topicFor(ref, 'request')}/${requestUuid}`;
}

export function requestStatusTopic(ref: EntityRef, requestUuid: string): string {
  return `${requestTopic(ref, requestUuid)}/status`;
}

export function disconnectionTopic(ref: EntityRef): string {
  return topicFor(ref, 'disconnection');
}

export function identityWildcard(): string {
  return `${ROOT_NAMESPACE}/+/+/identity`;
}

export function parseTopic(topic: string): ParsedTopic | null {
  if (!topic.startsWith(`${ROOT_NAMESPACE}/`)) return null;
  const rest = topic.slice(ROOT_NAMESPACE.length + 1).split('/');
  const [entityType, entityUuid, resource, ...tail] = rest;
  if (!entityType || !entityUuid || !resource) return null;
  if (resource === 'request' && tail.length >= 1) {
    const [requestUuid, maybeStatus] = tail;
    if (!requestUuid || (maybeStatus !== undefined && maybeStatus !== 'status') || tail.length > 2) return null;
    return { entityType, entityUuid, resource, requestUuid, isRequestStatus: maybeStatus === 'status' };
  }
  if (tail.length > 0) return null;
  return { entityType, entityUuid, resource, isRequestStatus: false };
}

/** MQTT 3.1.1 topic filter matching (+ single level, # multi level). */
export function topicFilterMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#') return true;
    if (i >= t.length) return false;
    if (seg !== '+' && seg !== t[i]) return false;
  }
  return f.length === t.length;
}
```

```typescript
// src/topics/resources.ts
export interface ResourceConfig { qos: 0 | 1 | 2; retain: boolean; minHz?: number; maxHz?: number }

/** Table B.1 — resources and their normative QoS / retain / rate configuration. */
export const RESOURCE_CONFIG: Record<string, ResourceConfig> = {
  identity: { qos: 1, retain: true },
  status: { qos: 1, retain: true },
  batteryStatus: { qos: 0, retain: true },
  footprint: { qos: 1, retain: true },
  odometry: { qos: 0, retain: false, minHz: 0.5, maxHz: 30 },
  localTrajectory: { qos: 0, retain: false, minHz: 1, maxHz: 10 },
  globalPath: { qos: 1, retain: true },
  globalPlan: { qos: 1, retain: true },
  request: { qos: 2, retain: true },
  requestStatus: { qos: 2, retain: true },
  activeRequestsStatus: { qos: 1, retain: true },
  disconnection: { qos: 1, retain: true },   // B.4 LWT parameters
};
```

```typescript
// src/topics/index.ts
export * from './topics.js';
export * from './resources.js';
```

Add to `src/index.ts`:

```typescript
export * from './topics/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/topics.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: topic builder/parser and Table B.1 resource registry"
```

---

### Task 4: JSON schema and validators

**Files:**
- Create: `src/schema/iso21423.schema.json`, `src/schema/validators.ts`, `src/schema/normalize.ts`, `src/schema/index.ts`
- Modify: `src/index.ts`, `tsconfig.json` (add `"resolveJsonModule": true`)
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces:
  - `type MessageKind = 'entityIdentity' | 'entityStatus' | 'batteryStatus' | 'odometry' | 'localTrajectory' | 'globalPath' | 'globalPlan' | 'request' | 'requestStatus' | 'requestStatusArray'`
  - `validateMessage(kind: MessageKind, value: unknown): ValidationResult` with `ValidationResult = { ok: boolean; value?: unknown; warnings: string[]; errors?: unknown[] }`
  - `normalizeInbound(kind: MessageKind, value: unknown): { value: unknown; warnings: string[] }` — applies §3.1 leniency (`id`→`entityId` on status; comma→dot on any `timestamp`/`arrivalTime` string field, recursively)
  - `assertValid(kind: MessageKind, value: unknown): void` — throws `ValidationError` (for egress)

- [ ] **Step 1: Write the failing tests** (fixtures are verbatim standard examples)

```typescript
// test/schema.test.ts
import { describe, it, expect } from 'vitest';
import { validateMessage, normalizeInbound, assertValid, ValidationError } from '../src/index.js';

const IDENTITY = {          // B.5.2.1 (trimmed but structurally complete)
  timestamp: '2025-04-08T12:34:56.789Z',
  id: '91403a21-7534-4467-99a6-79c46a130fe8',
  entityType: 'IMR',
  manufacturerName: 'acme',
  iso21423Version: '1.0',
  capabilities: {
    provides: ['identity', 'status', 'odometry', 'activeRequestsStatus'],
    accepts: { requests: ['pauseImr', 'resumeImr', 'move'] },
  },
  details: {
    imrModel: 'm1', imrSerialNumber: 's1',
    imrFootprint: [{ x: -2, y: -2 }, { x: -2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: -2 }],
    imrWorkingArea: [{ x: -3, y: -3 }, { x: -3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: -3 }],
    imrHeight: 1.5,
    softwareVersions: [{ moduleName: 'nav', moduleVersion: '2.1' }],
  },
};

const STATUS = {            // B.5.5.1
  entityId: 'd41e4efe-65e5-4070-8c0d-578c07f05ab4',
  timestamp: '2025-04-08T12:34:56.789Z',
  states: ['DOCKING', 'LOW_BATTERY', 'MODE_AUTO'],
  disabledCapabilities: { provides: [], accepts: { requests: ['move'] } },
};

const ODOMETRY = {          // B.5.7
  timestamp: '2025-04-08T12:34:56.789Z',
  pose: {
    locationPoint: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 0, y: 0, z: 0 },
    orientation: { yaw: 0, pitch: 0, roll: 0 },
  },
  velocity: { linear: 0, angular: 0 },
};

const REQUEST = {           // C.2.4.2.1 (first detail)
  source: '5f4d2824-d279-4fdf-9050-62e0cef72f25',
  destination: '42177726-26f7-4f5c-b735-a12a427bb96d',
  sequenceId: 42,
  timestamp: '2025-04-08T12:34:56.789Z',
  details: [{
    type: 'move', version: '0.1', format: 'ISO-21423', blocking: true, atomic: false,
    properties: {
      location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 },
      orientation: { yaw: 1, pitch: 0, roll: 0 },
    },
  }],
};

describe('validateMessage', () => {
  it('accepts the standard example payloads', () => {
    expect(validateMessage('entityIdentity', IDENTITY).ok).toBe(true);
    expect(validateMessage('entityStatus', STATUS).ok).toBe(true);
    expect(validateMessage('odometry', ODOMETRY).ok).toBe(true);
    expect(validateMessage('request', REQUEST).ok).toBe(true);
  });
  it('accepts empty destination (defect A1 patch)', () => {
    expect(validateMessage('request', { ...REQUEST, destination: '' }).ok).toBe(true);
  });
  it('rejects a request missing required fields', () => {
    const r = validateMessage('request', { source: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors!.length).toBeGreaterThan(0);
  });
  it('warns (not rejects) on unknown operating states', () => {
    const r = validateMessage('entityStatus', { ...STATUS, states: ['MODE_AUTO', 'VENDOR_SPECIAL'] });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('VENDOR_SPECIAL'))).toBe(true);
  });
});

describe('normalizeInbound (§3.1 leniency)', () => {
  it('renames id → entityId on status messages with a warning', () => {
    const { id: _drop, ...rest } = { ...STATUS } as Record<string, unknown> & { id?: string };
    const legacy = { ...rest, id: STATUS.entityId } as Record<string, unknown>;
    delete legacy.entityId;
    const { value, warnings } = normalizeInbound('entityStatus', legacy);
    expect((value as { entityId: string }).entityId).toBe(STATUS.entityId);
    expect(warnings.length).toBe(1);
  });
  it('converts comma-decimal timestamps to dot form', () => {
    const { value } = normalizeInbound('odometry', { ...ODOMETRY, timestamp: '2025-04-08T12:34:56,789Z' });
    expect((value as { timestamp: string }).timestamp).toBe('2025-04-08T12:34:56.789Z');
  });
});

describe('assertValid (egress)', () => {
  it('throws ValidationError with ajv details on invalid payload', () => {
    expect(() => assertValid('entityStatus', { states: 'nope' })).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Write the schema JSON** (Annex A–derived; `$defs` per message kind; §3.1 patches applied)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openrobops.org/schemas/iso21423/v1.json",
  "$defs": {
    "uuid": { "type": "string", "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
    "timestamp": { "type": "string", "format": "date-time" },
    "point": {
      "type": "object", "required": ["x", "y"],
      "properties": { "x": { "type": "number" }, "y": { "type": "number" } }
    },
    "locationPoint": {
      "type": "object", "required": ["ccsId", "x", "y", "z"],
      "properties": {
        "ccsId": { "$ref": "#/$defs/uuid" },
        "x": { "type": "number" }, "y": { "type": "number" }, "z": { "type": "number" }
      }
    },
    "orientation": {
      "type": "object", "required": ["yaw", "pitch", "roll"],
      "properties": { "yaw": { "type": "number" }, "pitch": { "type": "number" }, "roll": { "type": "number" } }
    },
    "capabilities": {
      "type": "object", "required": ["provides", "accepts"],
      "properties": {
        "provides": { "type": "array", "items": { "type": "string" } },
        "accepts": {
          "type": "object", "required": ["requests"],
          "properties": { "requests": { "type": "array", "items": { "type": "string" } } }
        },
        "manages": { "type": "array", "items": { "$ref": "#/$defs/uuid" } },
        "managedBy": { "$ref": "#/$defs/uuid" }
      }
    },
    "softwareVersion": {
      "type": "object", "required": ["moduleName", "moduleVersion"],
      "properties": { "moduleName": { "type": "string" }, "moduleVersion": { "type": "string" } }
    },
    "locationPointStamped": {
      "type": "object", "required": ["timestamp", "locationPoint"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "locationPoint": { "$ref": "#/$defs/locationPoint" }
      }
    },
    "requestDetail": {
      "type": "object", "required": ["type", "version"],
      "properties": {
        "type": { "type": "string" },
        "version": { "type": "string" },
        "format": { "type": "string" },
        "blocking": { "type": "boolean" },
        "atomic": { "type": "boolean" },
        "properties": { "type": "object" }
      }
    },
    "requestDetailStatus": {
      "type": "object", "required": ["type", "version", "status"],
      "properties": {
        "type": { "type": "string" },
        "version": { "type": "string" },
        "blocking": { "type": "boolean" },
        "status": {
          "type": "object", "required": ["code"],
          "properties": {
            "code": { "enum": ["RECEIVED", "ACCEPTED", "EXECUTING", "CANCELED", "SUCCEEDED", "ABORTED"] },
            "reason": { "type": "string" },
            "message": { "type": "string" }
          }
        },
        "properties": { "type": "object" }
      }
    },
    "entityIdentity": {
      "type": "object",
      "required": ["id", "timestamp", "entityType", "manufacturerName", "capabilities", "details"],
      "properties": {
        "id": { "$ref": "#/$defs/uuid" },
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "entityType": { "type": "string" },
        "manufacturerName": { "type": "string" },
        "iso21423Version": { "type": "string" },
        "capabilities": { "$ref": "#/$defs/capabilities" },
        "details": { "type": "object" }
      }
    },
    "entityStatus": {
      "type": "object", "required": ["entityId", "timestamp", "states"],
      "properties": {
        "entityId": { "$ref": "#/$defs/uuid" },
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "states": { "type": "array", "items": { "type": "string", "pattern": "^[A-Z0-9_]+$" } },
        "disabledCapabilities": { "$ref": "#/$defs/capabilities" }
      }
    },
    "batteryStatus": {
      "type": "object", "required": ["timestamp", "batterySoc"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "batterySoc": { "type": "number", "minimum": 0, "maximum": 1 },
        "batteryHealth": { "type": "string" },
        "batteryTemperature": { "type": "number" },
        "batteryVoltage": { "type": "number" },
        "batteryCurrent": { "type": "number" },
        "batteryChargingState": { "type": "string" }
      }
    },
    "odometry": {
      "type": "object", "required": ["timestamp", "pose"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "pose": {
          "type": "object", "required": ["locationPoint", "orientation"],
          "properties": {
            "locationPoint": { "$ref": "#/$defs/locationPoint" },
            "orientation": { "$ref": "#/$defs/orientation" }
          }
        },
        "velocity": {
          "type": "object", "required": ["linear", "angular"],
          "properties": { "linear": { "type": "number" }, "angular": { "type": "number" } }
        }
      }
    },
    "localTrajectory": {
      "type": "object", "required": ["timestamp", "localTrajectory"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "localTrajectory": { "type": "array", "items": { "$ref": "#/$defs/locationPointStamped" } }
      }
    },
    "globalPath": {
      "type": "object", "required": ["timestamp", "globalPath"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "globalPath": {
          "type": "object", "required": ["degree", "controlPoints", "knots"],
          "properties": {
            "degree": { "type": "integer", "minimum": 1 },
            "controlPoints": {
              "type": "array",
              "items": {
                "type": "object", "required": ["locationPoint"],
                "properties": {
                  "locationPoint": { "$ref": "#/$defs/locationPoint" },
                  "weight": { "type": "number" }
                }
              }
            },
            "knots": { "type": "array", "items": { "type": "number" }, "minItems": 4 }
          }
        }
      }
    },
    "globalPlan": {
      "type": "object", "required": ["timestamp", "globalPlan"],
      "properties": {
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "globalPlan": { "type": "array", "items": { "$ref": "#/$defs/locationPointStamped" } }
      }
    },
    "request": {
      "type": "object",
      "required": ["destination", "source", "sequenceId", "timestamp", "details"],
      "properties": {
        "destination": { "anyOf": [{ "$ref": "#/$defs/uuid" }, { "const": "" }] },
        "source": { "$ref": "#/$defs/uuid" },
        "sequenceId": { "type": "integer", "minimum": 0 },
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "priority": { "type": "integer", "minimum": 0, "maximum": 255 },
        "atomic": { "type": "boolean" },
        "details": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/requestDetail" } },
        "recoveries": { "type": "array", "items": { "$ref": "#/$defs/requestDetail" } }
      }
    },
    "requestStatus": {
      "type": "object",
      "required": ["source", "destination", "sequenceId", "requestSequenceId", "timestamp", "status", "detailStatuses"],
      "properties": {
        "source": { "$ref": "#/$defs/uuid" },
        "destination": { "$ref": "#/$defs/uuid" },
        "sequenceId": { "type": "integer", "minimum": 0 },
        "requestSequenceId": { "type": "integer", "minimum": 0 },
        "timestamp": { "$ref": "#/$defs/timestamp" },
        "status": { "enum": ["RECEIVED", "ACCEPTED", "EXECUTING", "CANCELED", "SUCCEEDED", "ABORTED", "RECOVERY"] },
        "detailStatuses": { "type": "array", "items": { "$ref": "#/$defs/requestDetailStatus" } },
        "recoveryStatuses": { "type": "array", "items": { "$ref": "#/$defs/requestDetailStatus" } }
      }
    },
    "requestStatusArray": { "type": "array", "items": { "$ref": "#/$defs/requestStatus" } }
  }
}
```

Save as `src/schema/iso21423.schema.json`. Add `"resolveJsonModule": true` to `tsconfig.json` `compilerOptions`.

- [ ] **Step 4: Implement normalize.ts and validators.ts**

```typescript
// src/schema/normalize.ts
const TIMESTAMP_KEYS = new Set(['timestamp', 'arrivalTime']);
const COMMA_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d+)(Z|[+-]\d{2}:?\d{2})$/;

function fixTimestamps(value: unknown, warnings: string[], path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => fixTimestamps(v, warnings, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TIMESTAMP_KEYS.has(k) && typeof v === 'string' && COMMA_TS.test(v)) {
      out[k] = v.replace(COMMA_TS, '$1.$2$3');
      warnings.push(`${path}.${k}: comma-decimal timestamp normalized to dot form`);
    } else {
      out[k] = fixTimestamps(v, warnings, `${path}.${k}`);
    }
  }
  return out;
}

export function normalizeInbound(kind: string, value: unknown): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];
  let v = fixTimestamps(value, warnings, kind);
  if (kind === 'entityStatus' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.entityId === undefined && typeof o.id === 'string') {
      const { id, ...rest } = o;
      v = { ...rest, entityId: id };
      warnings.push('entityStatus: legacy field "id" renamed to "entityId" (spec §3.1)');
    }
  }
  return { value: v, warnings };
}
```

```typescript
// src/schema/validators.ts
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from './iso21423.schema.json' with { type: 'json' };
import { KNOWN_OPERATING_STATES } from '../types/constants.js';
import { ValidationError } from '../errors.js';
import { normalizeInbound } from './normalize.js';

export type MessageKind =
  | 'entityIdentity' | 'entityStatus' | 'batteryStatus' | 'odometry'
  | 'localTrajectory' | 'globalPath' | 'globalPlan'
  | 'request' | 'requestStatus' | 'requestStatusArray';

export interface ValidationResult {
  ok: boolean;
  value?: unknown;
  warnings: string[];
  errors?: unknown[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema);

const KNOWN_STATES = new Set<string>(KNOWN_OPERATING_STATES);

function collectWarnings(kind: MessageKind, value: unknown, warnings: string[]): void {
  if (kind !== 'entityStatus') return;
  const states = (value as { states?: unknown })?.states;
  if (!Array.isArray(states)) return;
  for (const s of states) {
    if (typeof s === 'string' && !KNOWN_STATES.has(s)) {
      warnings.push(`entityStatus: unknown operating state "${s}" (deployment extension?)`);
    }
  }
}

export function validateMessage(kind: MessageKind, raw: unknown): ValidationResult {
  const { value, warnings } = normalizeInbound(kind, raw);
  const validate = ajv.getSchema(`https://openrobops.org/schemas/iso21423/v1.json#/$defs/${kind}`);
  if (!validate) throw new Error(`No schema for message kind: ${kind}`);
  const ok = validate(value) as boolean;
  collectWarnings(kind, value, warnings);
  return ok
    ? { ok: true, value, warnings }
    : { ok: false, value, warnings, errors: validate.errors ?? [] };
}

/** Egress guard: throws on non-conformant outbound payloads. */
export function assertValid(kind: MessageKind, value: unknown): void {
  const r = validateMessage(kind, value);
  if (!r.ok) {
    throw new ValidationError(`outbound ${kind} message is not ISO 21423 conformant`, r.errors ?? []);
  }
}
```

```typescript
// src/schema/index.ts
export * from './validators.js';
export { normalizeInbound } from './normalize.js';
```

Add to `src/index.ts`:

```typescript
export * from './schema/index.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/schema.test.ts && npm run typecheck && npm run build`
Expected: PASS (build confirms the JSON import works in both output formats).

- [ ] **Step 6: Commit**

```bash
git add src test tsconfig.json
git commit -m "feat: Annex A JSON schema with §3.1 patches, ajv validators, inbound normalization"
```

---

### Task 5: Geometry — CCS transform fit (Annex D)

**Files:**
- Create: `src/geometry/transform.ts`, `src/geometry/index.ts`
- Modify: `src/index.ts`
- Test: `test/geometry.test.ts`

**Interfaces:**
- Consumes: `Point` from Task 2.
- Produces:
  - `interface RigidTransform2D { rotation: number; tx: number; ty: number }` (radians; apply = rotate then translate)
  - `fitTransform(from: Point[], to: Point[]): RigidTransform2D` — least-squares rigid fit; throws `Iso21423Error` if fewer than 3 point pairs (Clause 4 requires ≥3 reference points) or lengths differ
  - `applyTransform(t: RigidTransform2D, p: Point): Point`
  - `invertTransform(t: RigidTransform2D): RigidTransform2D`
  - `transformYaw(t: RigidTransform2D, yaw: number): number`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/geometry.test.ts
import { describe, it, expect } from 'vitest';
import { fitTransform, applyTransform, invertTransform, transformYaw } from '../src/index.js';

const rot = (p: { x: number; y: number }, th: number, tx: number, ty: number) => ({
  x: Math.cos(th) * p.x - Math.sin(th) * p.y + tx,
  y: Math.sin(th) * p.x + Math.cos(th) * p.y + ty,
});

describe('fitTransform', () => {
  const local = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 7, y: 3 }];
  const TH = Math.PI / 6, TX = 4, TY = -2;
  const ccs = local.map((p) => rot(p, TH, TX, TY));

  it('recovers an exact rotation+translation', () => {
    const t = fitTransform(local, ccs);
    expect(t.rotation).toBeCloseTo(TH, 10);
    expect(t.tx).toBeCloseTo(TX, 10);
    expect(t.ty).toBeCloseTo(TY, 10);
  });

  it('is least-squares under measurement noise', () => {
    const noisy = ccs.map((p, i) => ({ x: p.x + (i % 2 ? 0.01 : -0.01), y: p.y + (i % 2 ? -0.01 : 0.01) }));
    const t = fitTransform(local, noisy);
    expect(t.rotation).toBeCloseTo(TH, 2);
    expect(t.tx).toBeCloseTo(TX, 1);
    expect(t.ty).toBeCloseTo(TY, 1);
  });

  it('rejects fewer than 3 point pairs (Clause 4)', () => {
    expect(() => fitTransform(local.slice(0, 2), ccs.slice(0, 2))).toThrow(/at least 3/);
  });
  it('rejects mismatched lengths', () => {
    expect(() => fitTransform(local, ccs.slice(0, 3))).toThrow(/same number/);
  });
});

describe('apply / invert / yaw', () => {
  const t = { rotation: Math.PI / 2, tx: 1, ty: 2 };
  it('applies rotation then translation', () => {
    const p = applyTransform(t, { x: 3, y: 0 });
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(5, 10);
  });
  it('invert ∘ apply is identity', () => {
    const inv = invertTransform(t);
    const p = applyTransform(inv, applyTransform(t, { x: 3, y: -4 }));
    expect(p.x).toBeCloseTo(3, 10);
    expect(p.y).toBeCloseTo(-4, 10);
  });
  it('transforms yaw and wraps to (-π, π]', () => {
    expect(transformYaw(t, Math.PI * 0.75)).toBeCloseTo(-Math.PI * 0.75, 10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/geometry.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement** (closed-form 2D Procrustes: centroid-center both sets, θ = atan2(Σcross, Σdot))

```typescript
// src/geometry/transform.ts
import type { Point } from '../types/ccs.js';
import { Iso21423Error } from '../errors.js';

export interface RigidTransform2D { rotation: number; tx: number; ty: number }

export function fitTransform(from: Point[], to: Point[]): RigidTransform2D {
  if (from.length !== to.length) {
    throw new Iso21423Error('fitTransform: point lists must have the same number of points');
  }
  if (from.length < 3) {
    throw new Iso21423Error('fitTransform: at least 3 reference point pairs are required (Clause 4)');
  }
  const n = from.length;
  let cfx = 0, cfy = 0, ctx = 0, cty = 0;
  for (let i = 0; i < n; i++) {
    cfx += from[i]!.x; cfy += from[i]!.y;
    ctx += to[i]!.x; cty += to[i]!.y;
  }
  cfx /= n; cfy /= n; ctx /= n; cty /= n;

  let sumCross = 0, sumDot = 0;
  for (let i = 0; i < n; i++) {
    const fx = from[i]!.x - cfx, fy = from[i]!.y - cfy;
    const tx = to[i]!.x - ctx, ty = to[i]!.y - cty;
    sumCross += fx * ty - fy * tx;
    sumDot += fx * tx + fy * ty;
  }
  const rotation = Math.atan2(sumCross, sumDot);
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return {
    rotation,
    tx: ctx - (cos * cfx - sin * cfy),
    ty: cty - (sin * cfx + cos * cfy),
  };
}

export function applyTransform(t: RigidTransform2D, p: Point): Point {
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation);
  return { x: cos * p.x - sin * p.y + t.tx, y: sin * p.x + cos * p.y + t.ty };
}

export function invertTransform(t: RigidTransform2D): RigidTransform2D {
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation);
  return {
    rotation: -t.rotation,
    tx: -(cos * t.tx + sin * t.ty),
    ty: -(-sin * t.tx + cos * t.ty),
  };
}

/** Rotates a yaw angle by the transform and wraps the result to (-π, π]. */
export function transformYaw(t: RigidTransform2D, yaw: number): number {
  let r = yaw + t.rotation;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}
```

```typescript
// src/geometry/index.ts
export * from './transform.js';
```

Add to `src/index.ts`:

```typescript
export * from './geometry/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/geometry.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: CCS rigid transform fit and pose helpers (Annex D)"
```

---

### Task 6: Request state machine (Figures C.3 / C.4)

**Files:**
- Create: `src/requests/stateMachine.ts`, `src/requests/index.ts`
- Modify: `src/index.ts`
- Test: `test/stateMachine.test.ts`

**Interfaces:**
- Consumes: `RequestState`, `DetailState`, `IllegalTransition` from Task 2.
- Produces (used by the Plan 2 executor and client sender):
  - `REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]>`
  - `DETAIL_TRANSITIONS: Record<DetailState, readonly DetailState[]>`
  - `isTerminalRequestState(s: RequestState): boolean` (true for CANCELED, SUCCEEDED, ABORTED)
  - `class RequestLifecycle { readonly state: RequestState; transition(to: RequestState): void; canTransition(to: RequestState): boolean; isTerminal(): boolean }` — starts in `RECEIVED`, `transition` throws `IllegalTransition` on invalid moves
  - `class DetailLifecycle` — same shape over `DetailState`, starts in `RECEIVED`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/stateMachine.test.ts
import { describe, it, expect } from 'vitest';
import {
  RequestLifecycle, DetailLifecycle, isTerminalRequestState,
  REQUEST_TRANSITIONS, IllegalTransition,
} from '../src/index.js';

describe('request lifecycle (Figure C.3)', () => {
  it('walks the happy path RECEIVED → ACCEPTED → EXECUTING → SUCCEEDED', () => {
    const lc = new RequestLifecycle();
    expect(lc.state).toBe('RECEIVED');
    lc.transition('ACCEPTED');
    lc.transition('EXECUTING');
    lc.transition('SUCCEEDED');
    expect(lc.isTerminal()).toBe(true);
  });
  it('allows EXECUTING → RECOVERY → ABORTED and RECOVERY → CANCELED', () => {
    const a = new RequestLifecycle();
    a.transition('ACCEPTED'); a.transition('EXECUTING'); a.transition('RECOVERY'); a.transition('ABORTED');
    expect(a.isTerminal()).toBe(true);
    const b = new RequestLifecycle();
    b.transition('ACCEPTED'); b.transition('EXECUTING'); b.transition('RECOVERY'); b.transition('CANCELED');
    expect(b.isTerminal()).toBe(true);
  });
  it('allows early rejection: RECEIVED → ABORTED', () => {
    const lc = new RequestLifecycle();
    lc.transition('ABORTED');
    expect(lc.isTerminal()).toBe(true);
  });
  it('rejects illegal transitions', () => {
    const lc = new RequestLifecycle();
    expect(() => lc.transition('SUCCEEDED')).toThrow(IllegalTransition);       // skip states
    lc.transition('ACCEPTED'); lc.transition('EXECUTING'); lc.transition('SUCCEEDED');
    expect(() => lc.transition('EXECUTING')).toThrow(IllegalTransition);       // out of terminal
    expect(() => new RequestLifecycle().transition('RECOVERY')).toThrow(IllegalTransition); // RECOVERY before ACCEPTED
  });
  it('every state in the transition table only names known states', () => {
    for (const [from, tos] of Object.entries(REQUEST_TRANSITIONS)) {
      for (const to of tos) expect(REQUEST_TRANSITIONS).toHaveProperty(to);
      expect(REQUEST_TRANSITIONS).toHaveProperty(from);
    }
  });
});

describe('detail lifecycle (Figure C.4)', () => {
  it('has no RECOVERY state and terminal SUCCEEDED/CANCELED/ABORTED', () => {
    const lc = new DetailLifecycle();
    lc.transition('ACCEPTED'); lc.transition('EXECUTING'); lc.transition('CANCELED');
    expect(lc.isTerminal()).toBe(true);
    expect(() => (lc as unknown as RequestLifecycle).transition('RECOVERY' as never)).toThrow();
  });
});

describe('isTerminalRequestState', () => {
  it('is true exactly for CANCELED, SUCCEEDED, ABORTED', () => {
    expect(isTerminalRequestState('CANCELED')).toBe(true);
    expect(isTerminalRequestState('SUCCEEDED')).toBe(true);
    expect(isTerminalRequestState('ABORTED')).toBe(true);
    expect(isTerminalRequestState('EXECUTING')).toBe(false);
    expect(isTerminalRequestState('RECOVERY')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stateMachine.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement**

```typescript
// src/requests/stateMachine.ts
import type { RequestState, DetailState } from '../types/constants.js';
import { IllegalTransition } from '../errors.js';

/** Figure C.3 — request message state transitions. */
export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RECEIVED: ['ACCEPTED', 'CANCELED', 'ABORTED'],
  ACCEPTED: ['EXECUTING', 'CANCELED', 'ABORTED', 'RECOVERY'],
  EXECUTING: ['SUCCEEDED', 'CANCELED', 'ABORTED', 'RECOVERY'],
  RECOVERY: ['CANCELED', 'ABORTED'],
  CANCELED: [],
  SUCCEEDED: [],
  ABORTED: [],
};

/** Figure C.4 — requestDetail state transitions (no RECOVERY at detail level). */
export const DETAIL_TRANSITIONS: Record<DetailState, readonly DetailState[]> = {
  RECEIVED: ['ACCEPTED', 'CANCELED', 'ABORTED'],
  ACCEPTED: ['EXECUTING', 'CANCELED', 'ABORTED'],
  EXECUTING: ['SUCCEEDED', 'CANCELED', 'ABORTED'],
  CANCELED: [],
  SUCCEEDED: [],
  ABORTED: [],
};

export function isTerminalRequestState(s: RequestState): boolean {
  return REQUEST_TRANSITIONS[s].length === 0;
}

class Lifecycle<S extends string> {
  #state: S;
  constructor(private readonly table: Record<S, readonly S[]>, initial: S) {
    this.#state = initial;
  }
  get state(): S {
    return this.#state;
  }
  canTransition(to: S): boolean {
    return (this.table[this.#state] as readonly S[]).includes(to);
  }
  transition(to: S): void {
    if (!this.canTransition(to)) {
      throw new IllegalTransition(`illegal transition ${this.#state} → ${to}`);
    }
    this.#state = to;
  }
  isTerminal(): boolean {
    return this.table[this.#state].length === 0;
  }
}

export class RequestLifecycle extends Lifecycle<RequestState> {
  constructor() { super(REQUEST_TRANSITIONS, 'RECEIVED'); }
}

export class DetailLifecycle extends Lifecycle<DetailState> {
  constructor() { super(DETAIL_TRANSITIONS, 'RECEIVED'); }
}
```

```typescript
// src/requests/index.ts
export * from './stateMachine.js';
```

Add to `src/index.ts`:

```typescript
export * from './requests/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stateMachine.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: request and detail state machines per Figures C.3/C.4"
```

---

### Task 7: MqttTransport interface + MemoryTransport fake

**Files:**
- Create: `src/session/transport.ts`, `src/testing/memoryTransport.ts`
- Modify: `src/testing/index.ts`, `src/index.ts`
- Test: `test/memoryTransport.test.ts`

**Interfaces:**
- Consumes: `topicFilterMatches` from Task 3.
- Produces:
  - `interface TransportMessage { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean }`
  - `interface WillOptions { topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean }`
  - `interface TransportConnectOptions { clientId: string; cleanSession: boolean; keepalive: number; will?: WillOptions; username?: string; password?: string }`
  - `type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'closed'`
  - `interface MqttTransport { connect(opts): Promise<void>; publish(topic, payload: string | Buffer, opts: { qos: 0|1|2; retain: boolean }): Promise<void>; subscribe(filter: string, opts: { qos: 0|1|2 }): Promise<{ granted: boolean }>; unsubscribe(filter: string): Promise<void>; onMessage(cb: (msg: TransportMessage) => void): void; onConnectionState(cb: (s: ConnectionState) => void): void; end(): Promise<void> }`
  - `class MemoryBroker { createTransport(): MemoryTransport; denySubscribe(filterPattern: string): void; retainedOn(topic: string): Buffer | undefined; messagesOn(topic: string): TransportMessage[] }`
  - `class MemoryTransport implements MqttTransport { dropConnection(): void }` — `dropConnection` simulates an ungraceful TCP loss: broker fires the will, transport reports `reconnecting` then auto-reconnects and reports `connected`
- Note: the real `mqtt`-backed transport is Plan 2 (facades) — nothing in Plan 1 needs a live broker.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/memoryTransport.test.ts
import { describe, it, expect } from 'vitest';
import { MemoryBroker } from '../src/testing/index.js';

const opts = (id: string) => ({ clientId: id, cleanSession: false, keepalive: 60 });

describe('MemoryBroker pub/sub', () => {
  it('routes by MQTT filter and preserves qos/retain metadata', async () => {
    const broker = new MemoryBroker();
    const a = broker.createTransport();
    const b = broker.createTransport();
    await a.connect(opts('a'));
    await b.connect(opts('b'));
    const seen: string[] = [];
    b.onMessage((m) => seen.push(`${m.topic}|${m.qos}|${m.retain}|${m.payload.toString()}`));
    await b.subscribe('/ISO_21423/v1/+/+/status', { qos: 1 });
    await a.publish('/ISO_21423/v1/IMR/u1/status', '{"x":1}', { qos: 1, retain: true });
    await a.publish('/ISO_21423/v1/IMR/u1/odometry', '{}', { qos: 0, retain: false }); // not matched
    expect(seen).toEqual(['/ISO_21423/v1/IMR/u1/status|1|true|{"x":1}']);
  });

  it('delivers retained messages to late subscribers', async () => {
    const broker = new MemoryBroker();
    const pub = broker.createTransport();
    await pub.connect(opts('pub'));
    await pub.publish('/ISO_21423/v1/IMR/u1/identity', '{"id":"u1"}', { qos: 1, retain: true });
    const sub = broker.createTransport();
    await sub.connect(opts('sub'));
    const seen: string[] = [];
    sub.onMessage((m) => seen.push(m.payload.toString()));
    await sub.subscribe('/ISO_21423/v1/+/+/identity', { qos: 1 });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['{"id":"u1"}']);
  });

  it('zero-byte retained publish clears the retained message', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    await t.connect(opts('t'));
    await t.publish('/x/y', 'keep', { qos: 1, retain: true });
    await t.publish('/x/y', '', { qos: 1, retain: true });
    expect(broker.retainedOn('/x/y')).toBeUndefined();
  });
});

describe('will and connection drops', () => {
  it('fires the will (retained) on ungraceful drop, not on graceful end', async () => {
    const broker = new MemoryBroker();
    const watcher = broker.createTransport();
    await watcher.connect(opts('w'));
    const seen: string[] = [];
    watcher.onMessage((m) => seen.push(`${m.topic}:${m.payload.toString()}`));
    await watcher.subscribe('/ISO_21423/v1/IMR/u1/disconnection', { qos: 1 });

    const dying = broker.createTransport();
    await dying.connect({
      ...opts('dying'),
      will: {
        topic: '/ISO_21423/v1/IMR/u1/disconnection',
        payload: '{"states":["LOST_CONNECTION"]}',
        qos: 1, retain: true,
      },
    });
    dying.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['/ISO_21423/v1/IMR/u1/disconnection:{"states":["LOST_CONNECTION"]}']);
    expect(broker.retainedOn('/ISO_21423/v1/IMR/u1/disconnection')).toBeDefined();

    const graceful = broker.createTransport();
    await graceful.connect({ ...opts('g'), will: { topic: '/w2', payload: 'x', qos: 1, retain: true } });
    await graceful.end();
    expect(broker.retainedOn('/w2')).toBeUndefined();
  });

  it('reports reconnecting → connected around a drop', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    await t.connect(opts('t'));
    t.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(states).toEqual(['connected', 'reconnecting', 'connected']);
  });
});

describe('subscription denial (ACL simulation)', () => {
  it('returns granted:false for denied filters', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/IMRFM/#');
    const t = broker.createTransport();
    await t.connect(opts('t'));
    expect((await t.subscribe('/ISO_21423/v1/IMRFM/#', { qos: 1 })).granted).toBe(false);
    expect((await t.subscribe('/ISO_21423/v1/+/+/identity', { qos: 1 })).granted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/memoryTransport.test.ts`
Expected: FAIL — MemoryBroker not exported.

- [ ] **Step 3: Implement transport interface and memory fake**

```typescript
// src/session/transport.ts
export interface TransportMessage { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean }

export interface WillOptions { topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean }

export interface TransportConnectOptions {
  clientId: string;
  cleanSession: boolean;
  keepalive: number;
  will?: WillOptions;
  username?: string;
  password?: string;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'closed';

export interface MqttTransport {
  connect(opts: TransportConnectOptions): Promise<void>;
  publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>;
  subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }>;
  unsubscribe(filter: string): Promise<void>;
  onMessage(cb: (msg: TransportMessage) => void): void;
  onConnectionState(cb: (s: ConnectionState) => void): void;
  end(): Promise<void>;
}
```

```typescript
// src/testing/memoryTransport.ts
import type {
  MqttTransport, TransportConnectOptions, TransportMessage, ConnectionState,
} from '../session/transport.js';
import { topicFilterMatches } from '../topics/topics.js';

interface Sub { filter: string; qos: 0 | 1 | 2 }

export class MemoryBroker {
  private clients = new Set<MemoryTransport>();
  private retained = new Map<string, TransportMessage>();
  private deniedFilters: string[] = [];
  private log: TransportMessage[] = [];

  createTransport(): MemoryTransport {
    const t = new MemoryTransport(this);
    this.clients.add(t);
    return t;
  }

  denySubscribe(filterPattern: string): void {
    this.deniedFilters.push(filterPattern);
  }

  isDenied(filter: string): boolean {
    return this.deniedFilters.includes(filter);
  }

  retainedOn(topic: string): Buffer | undefined {
    return this.retained.get(topic)?.payload;
  }

  messagesOn(topic: string): TransportMessage[] {
    return this.log.filter((m) => m.topic === topic);
  }

  route(msg: TransportMessage): void {
    this.log.push(msg);
    if (msg.retain) {
      if (msg.payload.length === 0) this.retained.delete(msg.topic);
      else this.retained.set(msg.topic, msg);
    }
    for (const c of this.clients) c.deliver(msg);
  }

  deliverRetained(to: MemoryTransport, filter: string): void {
    for (const msg of this.retained.values()) {
      if (topicFilterMatches(filter, msg.topic)) {
        setImmediate(() => to.deliver(msg, filter));
      }
    }
  }

  disconnected(t: MemoryTransport, ungraceful: boolean): void {
    if (ungraceful && t.will) {
      this.route({
        topic: t.will.topic,
        payload: Buffer.from(t.will.payload),
        qos: t.will.qos,
        retain: t.will.retain,
      });
    }
  }
}

export class MemoryTransport implements MqttTransport {
  will: TransportConnectOptions['will'];
  private subs: Sub[] = [];
  private messageCbs: Array<(m: TransportMessage) => void> = [];
  private stateCbs: Array<(s: ConnectionState) => void> = [];
  private connected = false;

  constructor(private readonly broker: MemoryBroker) {}

  async connect(opts: TransportConnectOptions): Promise<void> {
    this.will = opts.will;
    this.connected = true;
    this.emitState('connected');
  }

  async publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void> {
    this.broker.route({
      topic,
      payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
      qos: opts.qos,
      retain: opts.retain,
    });
  }

  async subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }> {
    if (this.broker.isDenied(filter)) return { granted: false };
    this.subs.push({ filter, qos: opts.qos });
    this.broker.deliverRetained(this, filter);
    return { granted: true };
  }

  async unsubscribe(filter: string): Promise<void> {
    this.subs = this.subs.filter((s) => s.filter !== filter);
  }

  onMessage(cb: (m: TransportMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onConnectionState(cb: (s: ConnectionState) => void): void {
    this.stateCbs.push(cb);
  }

  deliver(msg: TransportMessage, viaFilter?: string): void {
    if (!this.connected) return;
    const matched = viaFilter !== undefined
      || this.subs.some((s) => topicFilterMatches(s.filter, msg.topic));
    if (matched) for (const cb of this.messageCbs) cb(msg);
  }

  /** Simulate ungraceful TCP loss: will fires, then auto-reconnect. */
  dropConnection(): void {
    this.connected = false;
    this.emitState('reconnecting');
    this.broker.disconnected(this, true);
    setImmediate(() => {
      this.connected = true;
      this.emitState('connected');
    });
  }

  async end(): Promise<void> {
    this.connected = false;
    this.broker.disconnected(this, false);
    this.emitState('closed');
  }

  private emitState(s: ConnectionState): void {
    for (const cb of this.stateCbs) cb(s);
  }
}
```

```typescript
// src/testing/index.ts (replace content)
export { MemoryBroker, MemoryTransport } from './memoryTransport.js';
```

Add to `src/index.ts`:

```typescript
export type {
  MqttTransport, TransportConnectOptions, TransportMessage, WillOptions, ConnectionState,
} from './session/transport.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/memoryTransport.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: MqttTransport interface and in-memory broker/transport fake"
```

---

### Task 8: Rate gate (Table B.1 streaming bounds)

**Files:**
- Create: `src/session/rateGate.ts`
- Modify: `src/index.ts`
- Test: `test/rateGate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class RateGate { constructor(maxHz: number); offer<T>(value: T, emit: (v: T) => void): void; dispose(): void }` — emits immediately when the min interval has elapsed; otherwise stores the **latest** value and flushes it when the interval expires (latest-wins, telemetry semantics — never queues stale samples).

- [ ] **Step 1: Write the failing tests** (use vitest fake timers)

```typescript
// test/rateGate.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateGate } from '../src/index.js';

describe('RateGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits the first value immediately', () => {
    const gate = new RateGate(10); // 10 Hz → 100 ms
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    expect(out).toEqual([1]);
  });

  it('coalesces bursts to latest-wins at the rate bound', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    gate.offer(2, (v) => out.push(v));   // within 100 ms — deferred
    gate.offer(3, (v) => out.push(v));   // replaces 2
    expect(out).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(out).toEqual([1, 3]);         // only the latest flushed
  });

  it('emits immediately again after the interval has passed idle', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    vi.advanceTimersByTime(150);
    gate.offer(2, (v) => out.push(v));
    expect(out).toEqual([1, 2]);
  });

  it('dispose cancels any pending flush', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    gate.offer(2, (v) => out.push(v));
    gate.dispose();
    vi.advanceTimersByTime(500);
    expect(out).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rateGate.test.ts`
Expected: FAIL — RateGate not exported.

- [ ] **Step 3: Implement**

```typescript
// src/session/rateGate.ts
/**
 * Latest-wins rate limiter for streaming telemetry (Table B.1 bounds).
 * Emits immediately when the minimum interval has elapsed; otherwise keeps
 * only the newest value and flushes it when the interval expires.
 */
export class RateGate {
  private readonly intervalMs: number;
  private lastEmit = -Infinity;
  private pending?: { value: unknown; emit: (v: never) => void };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(maxHz: number) {
    this.intervalMs = 1000 / maxHz;
  }

  offer<T>(value: T, emit: (v: T) => void): void {
    const now = Date.now();
    if (now - this.lastEmit >= this.intervalMs) {
      this.lastEmit = now;
      emit(value);
      return;
    }
    this.pending = { value, emit: emit as (v: never) => void };
    if (this.timer === undefined) {
      const wait = this.intervalMs - (now - this.lastEmit);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const p = this.pending;
        this.pending = undefined;
        if (p) {
          this.lastEmit = Date.now();
          (p.emit as (v: unknown) => void)(p.value);
        }
      }, wait);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
```

Add to `src/index.ts`:

```typescript
export { RateGate } from './session/rateGate.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rateGate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: latest-wins RateGate for streaming resource bounds"
```

---

### Task 9: Conformant session layer

**Files:**
- Create: `src/session/session.ts`, `src/session/index.ts`
- Modify: `src/index.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `MqttTransport` + option types (Task 7), `RateGate` (Task 8), `RESOURCE_CONFIG`/topic functions (Task 3), `validateMessage`/`assertValid`/`MessageKind` (Task 4), `EntityRef` (Task 3), `nowTimestamp` (Task 2), `AuthorizationDenied` (Task 2).
- Produces (the substrate Plan 2 facades build on):
  - `interface SessionOptions { transport: MqttTransport; entity: EntityRef; credentials?: { username?: string; password?: string }; validateOutbound?: boolean /* default true */ }`
  - `class Iso21423Session`:
    - `static async connect(opts: SessionOptions): Promise<Iso21423Session>` — connects with `cleanSession: false`, `keepalive: 60`, clientId `iso21423-<entityType>-<entityUuid>`, the B.4 will; then zero-byte-clears any stale retained `disconnection` message
    - `publishResource(ref: EntityRef, resource: string, kind: MessageKind | null, payload: unknown): Promise<void>` — QoS/retain from `RESOURCE_CONFIG` (throws on unknown resource); egress `assertValid` when `kind` is non-null and `validateOutbound`; change-guard for retained resources (deep-equal skip); `RateGate` for resources with `maxHz`
    - `subscribeResource(filter: { entityType?: string; entityUuid?: string }, resource: string, kind: MessageKind | null, handler: (msg: unknown, meta: { topic: string; entityType: string; entityUuid: string }) => void): Promise<Subscription>` — throws `AuthorizationDenied` on SUBACK denial; validates + normalizes inbound when `kind` non-null, emitting `validation-warning` events instead of calling the handler on invalid payloads; `Subscription = { unsubscribe(): Promise<void> }`
    - `publishRaw(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>` and `clearRetained(topic: string): Promise<void>` (zero-byte publish)
    - `on(event: 'connection' | 'validation-warning', cb): void` — `connection` relays `ConnectionState`; on transport `connected` after a drop, republishes all retained resources this session has published (reconnect rule, spec §4)
    - `close(finalStates?: string[]): Promise<void>` — optionally publishes a final `status` for the session entity, then graceful `end()` (will suppressed by transport)

- [ ] **Step 1: Write the failing tests**

```typescript
// test/session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Iso21423Session, AuthorizationDenied, nowTimestamp } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const STATUS_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/status`;
const DISC_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/disconnection`;

const status = (states: string[]) => ({
  entityId: IMR.entityUuid, timestamp: '2025-04-08T12:34:56.789Z', states,
});

async function connect(broker: MemoryBroker) {
  return Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
}

describe('connect conformance', () => {
  it('clears a stale retained disconnection message on connect', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    await t.connect({ clientId: 'x', cleanSession: false, keepalive: 60 });
    await t.publish(DISC_TOPIC, '{"states":["LOST_CONNECTION"]}', { qos: 1, retain: true });
    await connect(broker);
    expect(broker.retainedOn(DISC_TOPIC)).toBeUndefined();
  });

  it('drops with the B.4 will: retained LOST_CONNECTION appears on ungraceful loss', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    await Iso21423Session.connect({ transport, entity: IMR });
    transport.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(broker.retainedOn(DISC_TOPIC)?.toString()).toBe('{"states":["LOST_CONNECTION"]}');
  });
});

describe('publishResource', () => {
  it('uses Table B.1 qos/retain and validates egress', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.publishResource(IMR, 'status', 'entityStatus', status(['MODE_AUTO', 'IDLE']));
    const [msg] = broker.messagesOn(STATUS_TOPIC);
    expect(msg!.qos).toBe(1);
    expect(msg!.retain).toBe(true);
    await expect(s.publishResource(IMR, 'status', 'entityStatus', { states: 'bad' }))
      .rejects.toThrow(/not ISO 21423 conformant/);
  });

  it('suppresses unchanged retained publishes (on-change rule)', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    await s.publishResource(IMR, 'status', 'entityStatus', status(['MODE_AUTO', 'CHARGING']));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(2);
  });

  it('rejects unknown resources', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await expect(s.publishResource(IMR, 'bogus', null, {})).rejects.toThrow(/unknown resource/i);
  });
});

describe('subscribeResource', () => {
  it('delivers validated messages with topic metadata', async () => {
    const broker = new MemoryBroker();
    const pub = await connect(broker);
    const sub = await connect(broker);
    const seen: Array<{ states: string[] }> = [];
    await sub.subscribeResource({}, 'status', 'entityStatus', (m) => seen.push(m as { states: string[] }));
    await pub.publishResource(IMR, 'status', 'entityStatus', status(['LOST', 'MODE_MANUAL']));
    await new Promise((r) => setImmediate(r));
    expect(seen[0]!.states).toEqual(['LOST', 'MODE_MANUAL']);
  });

  it('routes malformed third-party payloads to validation-warning, not the handler', async () => {
    const broker = new MemoryBroker();
    const sub = await connect(broker);
    const handler = vi.fn();
    const warnings: unknown[] = [];
    sub.on('validation-warning', (w) => warnings.push(w));
    await sub.subscribeResource({}, 'status', 'entityStatus', handler);
    const rogue = broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    await rogue.publish(STATUS_TOPIC, 'not json at all', { qos: 1, retain: false });
    await rogue.publish(STATUS_TOPIC, '{"states": 42}', { qos: 1, retain: false });
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(2);
  });

  it('throws AuthorizationDenied when the broker denies the filter', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/+/+/status');
    const s = await connect(broker);
    await expect(s.subscribeResource({}, 'status', 'entityStatus', () => {}))
      .rejects.toThrow(AuthorizationDenied);
  });
});

describe('reconnect and close', () => {
  it('republishes owned retained resources after reconnect', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    const s = await Iso21423Session.connect({ transport, entity: IMR });
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(1);
    transport.dropConnection();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(2); // republished
  });

  it('close(finalStates) publishes a final status then ends without firing the will', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.close(['OFFLINE', 'MODE_MAINTENANCE']);
    const msgs = broker.messagesOn(STATUS_TOPIC);
    const final = JSON.parse(msgs.at(-1)!.payload.toString()) as { states: string[] };
    expect(final.states).toEqual(['OFFLINE', 'MODE_MAINTENANCE']);
    expect(broker.retainedOn(DISC_TOPIC)).toBeUndefined(); // will did not fire
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — Iso21423Session not exported.

- [ ] **Step 3: Implement**

```typescript
// src/session/session.ts
import type { MqttTransport, ConnectionState } from './transport.js';
import { RateGate } from './rateGate.js';
import { RESOURCE_CONFIG } from '../topics/resources.js';
import {
  topicFor, disconnectionTopic, parseTopic, type EntityRef,
} from '../topics/topics.js';
import { ROOT_NAMESPACE, LOST_CONNECTION_STATE } from '../types/constants.js';
import { nowTimestamp } from '../types/common.js';
import { validateMessage, assertValid, type MessageKind } from '../schema/validators.js';
import { AuthorizationDenied, Iso21423Error } from '../errors.js';

export interface SessionOptions {
  transport: MqttTransport;
  entity: EntityRef;
  credentials?: { username?: string; password?: string };
  validateOutbound?: boolean;
}

export interface Subscription { unsubscribe(): Promise<void> }

export interface ValidationWarningEvent {
  topic: string;
  payload: string;
  errors: unknown[];
}

type SessionEvents = {
  connection: (s: ConnectionState) => void;
  'validation-warning': (w: ValidationWarningEvent) => void;
};

interface ResourceSub {
  filter: string;
  resource: string;
  kind: MessageKind | null;
  handler: (msg: unknown, meta: { topic: string; entityType: string; entityUuid: string }) => void;
}

export class Iso21423Session {
  private retainedOwned = new Map<string, { payload: string; qos: 0 | 1 | 2 }>();
  private rateGates = new Map<string, RateGate>();
  private resourceSubs: ResourceSub[] = [];
  private listeners: { [K in keyof SessionEvents]: Array<SessionEvents[K]> } = {
    connection: [], 'validation-warning': [],
  };
  private wasConnected = false;

  private constructor(
    private readonly transport: MqttTransport,
    readonly entity: EntityRef,
    private readonly validateOutbound: boolean,
  ) {}

  static async connect(opts: SessionOptions): Promise<Iso21423Session> {
    const session = new Iso21423Session(opts.transport, opts.entity, opts.validateOutbound ?? true);
    opts.transport.onMessage((m) => session.dispatch(m.topic, m.payload));
    opts.transport.onConnectionState((s) => session.handleConnectionState(s));
    await opts.transport.connect({
      clientId: `iso21423-${opts.entity.entityType}-${opts.entity.entityUuid}`,
      cleanSession: false,
      keepalive: 60,
      username: opts.credentials?.username,
      password: opts.credentials?.password,
      will: {
        topic: disconnectionTopic(opts.entity),
        payload: JSON.stringify({ states: [LOST_CONNECTION_STATE] }),
        qos: 1,
        retain: true,
      },
    });
    // Clear stale retained LOST_CONNECTION from a prior crash (spec §4).
    await session.clearRetained(disconnectionTopic(opts.entity));
    return session;
  }

  on<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void {
    this.listeners[event].push(cb);
  }

  async publishResource(ref: EntityRef, resource: string, kind: MessageKind | null, payload: unknown): Promise<void> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    if (kind && this.validateOutbound) assertValid(kind, payload);
    const topic = topicFor(ref, resource);
    const body = JSON.stringify(payload);

    if (config.retain) {
      if (this.retainedOwned.get(topic)?.payload === body) return; // on-change rule
      this.retainedOwned.set(topic, { payload: body, qos: config.qos });
      await this.transport.publish(topic, body, { qos: config.qos, retain: true });
      return;
    }
    if (config.maxHz !== undefined) {
      let gate = this.rateGates.get(topic);
      if (!gate) {
        gate = new RateGate(config.maxHz);
        this.rateGates.set(topic, gate);
      }
      gate.offer(body, (b) => {
        void this.transport.publish(topic, b, { qos: config.qos, retain: false });
      });
      return;
    }
    await this.transport.publish(topic, body, { qos: config.qos, retain: false });
  }

  async subscribeResource(
    filter: { entityType?: string; entityUuid?: string },
    resource: string,
    kind: MessageKind | null,
    handler: ResourceSub['handler'],
  ): Promise<Subscription> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    const topicFilter = `${ROOT_NAMESPACE}/${filter.entityType ?? '+'}/${filter.entityUuid ?? '+'}/${resource}`;
    const { granted } = await this.transport.subscribe(topicFilter, { qos: config.qos });
    if (!granted) {
      throw new AuthorizationDenied(`subscription denied by broker: ${topicFilter}`, topicFilter);
    }
    const sub: ResourceSub = { filter: topicFilter, resource, kind, handler };
    this.resourceSubs.push(sub);
    return {
      unsubscribe: async () => {
        this.resourceSubs = this.resourceSubs.filter((s) => s !== sub);
        if (!this.resourceSubs.some((s) => s.filter === topicFilter)) {
          await this.transport.unsubscribe(topicFilter);
        }
      },
    };
  }

  async publishRaw(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void> {
    await this.transport.publish(topic, payload, opts);
  }

  async clearRetained(topic: string): Promise<void> {
    this.retainedOwned.delete(topic);
    await this.transport.publish(topic, '', { qos: 1, retain: true });
  }

  async close(finalStates?: string[]): Promise<void> {
    if (finalStates) {
      await this.publishResource(this.entity, 'status', 'entityStatus', {
        entityId: this.entity.entityUuid,
        timestamp: nowTimestamp(),
        states: finalStates,
      });
    }
    for (const gate of this.rateGates.values()) gate.dispose();
    await this.transport.end();
  }

  private dispatch(topic: string, payload: Buffer): void {
    const parsed = parseTopic(topic);
    if (!parsed) return;
    for (const sub of this.resourceSubs) {
      if (parsed.resource !== sub.resource) continue;
      const meta = { topic, entityType: parsed.entityType, entityUuid: parsed.entityUuid };
      const text = payload.toString();
      if (!sub.kind) {
        sub.handler(text, meta);
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.emitWarning({ topic, payload: text, errors: ['invalid JSON'] });
        continue;
      }
      const result = validateMessage(sub.kind, value);
      if (!result.ok) {
        this.emitWarning({ topic, payload: text, errors: result.errors ?? [] });
        continue;
      }
      sub.handler(result.value, meta);
    }
  }

  private handleConnectionState(s: ConnectionState): void {
    for (const cb of this.listeners.connection) cb(s);
    if (s === 'connected' && this.wasConnected) {
      // Reconnect: republish owned retained resources (broker may have lost them).
      for (const [topic, { payload, qos }] of this.retainedOwned) {
        void this.transport.publish(topic, payload, { qos, retain: true });
      }
    }
    if (s === 'connected') this.wasConnected = true;
  }

  private emitWarning(w: ValidationWarningEvent): void {
    for (const cb of this.listeners['validation-warning']) cb(w);
  }
}
```

```typescript
// src/session/index.ts
export * from './transport.js';
export * from './session.js';
export { RateGate } from './rateGate.js';
```

Replace the session-related exports in `src/index.ts` with:

```typescript
export * from './session/index.js';
```

(Remove the now-duplicated `export type { MqttTransport, ... }` and `export { RateGate }` lines from Task 7/8 — `session/index.ts` covers them.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/session.test.ts && npm test && npm run typecheck && npm run build`
Expected: full suite PASS, clean build.

- [ ] **Step 5: Verify CJS + ESM consumability of the full foundation**

Run:
```bash
node -e "const s = require('./dist/index.cjs'); console.log(typeof s.Iso21423Session.connect, s.RESOURCE_CONFIG.odometry.maxHz)"
node --input-type=module -e "import { Iso21423Session, RESOURCE_CONFIG } from './dist/index.js'; console.log(typeof Iso21423Session.connect, RESOURCE_CONFIG.odometry.maxHz)"
```
Expected: both print `function 30`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: conformant Iso21423Session (LWT, QoS registry, on-change, rate gating, reconnect republish)"
```

---

## Out of scope for this plan (later plans)

- **Plan 2 — Facades:** real `mqtt`-backed transport, `FleetGateway` + request executor + concurrency policies + janitor, `Iso21423Client` + discovery + request sender (sequenceId persistence), subpath exports for `/gateway` `/client` etc., integration test suite (spec §9.2 combined scenarios), GitHub Actions CI + GitHub Packages publishing (spec §11.3).
- **Plan 3 — Examples + e2e:** `imr-simulator`, `imrfm-gateway-template`, `fleet-observer`, `facility-sandbox`, `ScenarioRunner` conformance suite (spec §9.3–9.4, §10).
- **Plan 4 — ORO bridge:** `oro/ingest/src/server/iso21423/` adapter (spec §11.2), in the `oro` repository.
