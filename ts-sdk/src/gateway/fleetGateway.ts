import type { MqttTransport } from '../session/transport.js';
import type { Uuid } from '../types/common.js';
import type { Request } from '../types/requests.js';
import { Iso21423Error } from '../errors.js';
import { Iso21423Client } from '../core/client.js';
import { EntityHandle } from '../core/entityHandle.js';
import type { ActionExecutor } from '../core/executor.js';
import type { DispatchTarget } from '../core/requestServer.js';
import type { ActionHandler, ExecutionPolicy, SecurityOptions } from '../core/types.js';
import type { SequenceStore } from '../core/sequence.js';
import { publishSelfCheck } from './selfCheck.js';
import { RetainedRequestJanitor } from './janitor.js';

const DEFAULT_JANITOR_GRACE_MS = 30_000;

export interface FleetGatewayOptions {
  transport?: MqttTransport;
  url?: string;
  security?: SecurityOptions;
  imrfm: {
    id: Uuid;
    manufacturerName: string;
    details?: Record<string, unknown>;
    accepts?: string[];
    provides?: string[];
  };
  janitor?: { enabled?: boolean; graceMs?: number };
  validateOutbound?: boolean;
  sequenceStore?: SequenceStore | null;
  requestTimeoutMs?: number;
}

export interface ImrRegistration {
  id: Uuid;
  identity?: Record<string, unknown>;
  manufacturerName?: string;
  accepts?: string[];
  provides?: string[];
  executionPolicy?: ExecutionPolicy;
}

/**
 * Fleet-wide facade (ISO 21423 IMRFM role): owns one `Iso21423Client`, the IMRFM's own
 * `EntityHandle`, and every managed IMR's handle. Adds three things on top of `/core`: fleet-wide
 * `onRequest` handlers replayed onto current/future robots (controller ruling R6), the
 * empty-destination dispatch callback (ND-12), and a retained-request janitor + publish
 * self-check that both default ON (ND-10, ND-15).
 */
export class FleetGateway {
  private readonly imrHandles = new Map<Uuid, EntityHandle>();
  // Provenance tracking for R6: the core-level ActionExecutor only knows "a handler for this type
  // exists or not" — it has no notion of "fleet-wide" vs "per-imr" scope. These two maps let the
  // gateway apply its own override rule (same-scope re-registration needs override:true; a
  // per-imr registration shadowing a fleet-wide one never does) while always calling the
  // underlying `EntityHandle.onRequest` with `override: true` so the core-level guard never trips
  // on the gateway's own layering.
  private readonly fleetHandlers = new Map<string, ActionHandler>();
  private readonly perImrHandlerTypes = new Set<string>();
  private janitor?: RetainedRequestJanitor;
  private dispatchCb?: (request: Request, imrs: EntityHandle[]) => Uuid | null;

  private constructor(
    readonly client: Iso21423Client,
    readonly imrfm: EntityHandle,
    private readonly selfCheckEnabled: boolean,
    private readonly selfCheckTimeoutMs: number | undefined,
  ) {}

  static async connect(opts: FleetGatewayOptions): Promise<FleetGateway> {
    const client = await Iso21423Client.connect({
      transport: opts.transport,
      url: opts.url,
      // Deliberately NOT forwarding security.selfCheck/selfCheckTimeoutMs: the gateway runs its
      // own self-check below (default ON) instead of the client's own (default OFF) — running
      // both would just double the identity-echo round trip.
      security: opts.security && {
        username: opts.security.username, password: opts.security.password, tls: opts.security.tls,
      },
      validateOutbound: opts.validateOutbound,
      sequenceStore: opts.sequenceStore,
      requestTimeoutMs: opts.requestTimeoutMs,
    });

    // First operation on the client (decision 1): arms the B.4 Last Will.
    const imrfm = await client.registerSelfEntity({
      entityUuid: opts.imrfm.id,
      entityType: 'IMRFM',
      manufacturerName: opts.imrfm.manufacturerName,
      details: opts.imrfm.details,
      capabilities: { provides: opts.imrfm.provides ?? [], accepts: opts.imrfm.accepts ?? [] },
    });

    const gateway = new FleetGateway(
      client, imrfm, opts.security?.selfCheck !== false, opts.security?.selfCheckTimeoutMs);

    if (gateway.selfCheckEnabled) {
      await publishSelfCheck(imrfm.ctx.session, imrfm.ctx.ref, gateway.selfCheckTimeoutMs);
    }

    if (opts.janitor?.enabled !== false) {
      const graceMs = opts.janitor?.graceMs ?? DEFAULT_JANITOR_GRACE_MS;
      gateway.janitor = new RetainedRequestJanitor(
        imrfm.ctx.session, graceMs,
        (topic) => imrfm.ctx.diagnostic('janitor-cleared', { topic }));
      await imrfm.onRequestSettled((topic) => gateway.janitor!.note(topic));
    }

    await imrfm.setDispatchInterceptor((request) => gateway.resolveDispatch(request));
    // ND-12: a dispatched request runs in the target robot's executor, not the IMRFM's own — a
    // cancelRequest for it must be resolvable there too (controller ruling).
    await imrfm.setManagedExecutorsHook(() => gateway.imrs()
      .map((h) => h.dispatchTarget()?.executor)
      .filter((e): e is ActionExecutor => e !== undefined));

    return gateway;
  }

  async registerImr(reg: ImrRegistration): Promise<EntityHandle> {
    const handle = await this.client.registerManagedEntity(this.imrfm.entityUuid, {
      entityUuid: reg.id,
      entityType: 'IMR',
      manufacturerName: reg.manufacturerName ?? this.imrfm.identity().manufacturerName,
      details: reg.identity,
      capabilities: { accepts: reg.accepts ?? [], provides: reg.provides ?? [] },
      executionPolicy: reg.executionPolicy,
    });

    if (this.janitor) await handle.onRequestSettled((topic) => this.janitor!.note(topic));

    for (const [type, handler] of this.fleetHandlers) handle.onRequest(type, handler, { override: true });

    this.imrHandles.set(reg.id, handle);

    if (this.selfCheckEnabled) {
      try {
        await publishSelfCheck(handle.ctx.session, handle.ctx.ref, this.selfCheckTimeoutMs);
      } catch (err) {
        // Rollback (best-effort, local only): nothing is retained on the broker to clean up — a
        // denied publish never lands there in the first place (that's the whole point of ND-15)
        // — so undoing our own bookkeeping (the handle list and the manager's manages array) is
        // all there is to do before rethrowing.
        this.imrHandles.delete(reg.id);
        this.client.removeManagedEntity(this.imrfm.entityUuid, reg.id);
        const identity = this.imrfm.identity();
        const manages = (identity.capabilities.manages ?? []).filter((uuid) => uuid !== reg.id);
        await this.imrfm.updateIdentity({ capabilities: { ...identity.capabilities, manages } });
        throw err;
      }
    }

    return handle;
  }

  async unregisterImr(id: Uuid): Promise<void> {
    const handle = this.imrHandles.get(id);
    if (!handle) return;
    await handle.unregister();
    this.imrHandles.delete(id);
    const identity = this.imrfm.identity();
    const manages = (identity.capabilities.manages ?? []).filter((uuid) => uuid !== id);
    await this.imrfm.updateIdentity({ capabilities: { ...identity.capabilities, manages } });
  }

  imrs(): EntityHandle[] {
    return [...this.imrHandles.values()];
  }

  onRequest<P = Record<string, unknown>>(
    type: string, handler: ActionHandler<P>, opts?: { imr?: Uuid; override?: true },
  ): void {
    const asHandler = handler as ActionHandler;
    if (opts?.imr) {
      const handle = this.imrHandles.get(opts.imr);
      if (!handle) throw new Iso21423Error(`FleetGateway.onRequest: unknown imr "${opts.imr}"`);
      const key = `${opts.imr}:${type}`;
      if (this.perImrHandlerTypes.has(key) && !opts.override) {
        throw new Iso21423Error(
          `FleetGateway.onRequest: a per-imr handler for "${type}" on "${opts.imr}" is already ` +
          `registered — pass { override: true } to replace it`);
      }
      this.perImrHandlerTypes.add(key);
      // Always override at the core level: this may be shadowing a fleet-wide handler already
      // registered on this same handle (R6) — the gateway's own provenance check above is the
      // real guard against a genuine same-scope duplicate registration.
      handle.onRequest(type, asHandler, { override: true });
      return;
    }
    if (this.fleetHandlers.has(type) && !opts?.override) {
      throw new Iso21423Error(
        `FleetGateway.onRequest: a fleet-wide handler for "${type}" is already registered — ` +
        `pass { override: true } to replace it`);
    }
    this.fleetHandlers.set(type, asHandler);
    this.imrfm.onRequest(type, asHandler, { override: true });
    // Registration order matters: this replay always uses override:true, so a fleet-wide
    // registration made AFTER a per-imr override for the same type replaces that override on
    // every current robot (a later per-imr call would still win back on that one robot).
    for (const handle of this.imrHandles.values()) handle.onRequest(type, asHandler, { override: true });
  }

  onDispatch(cb: (request: Request, imrs: EntityHandle[]) => Uuid | null): void {
    this.dispatchCb = cb;
  }

  /** Graceful shutdown: managed handles are NOT unregistered — a fleet restart should not erase
   *  the fleet's retained state; call `unregisterImr` explicitly for that. */
  async close(opts?: { timeout?: number }): Promise<void> {
    this.janitor?.dispose();
    await this.client.close(opts);
  }

  private resolveDispatch(request: Request): DispatchTarget | null {
    if (!this.dispatchCb) return null;
    const uuid = this.dispatchCb(request, this.imrs());
    if (!uuid) return null;
    const handle = this.imrHandles.get(uuid);
    return handle?.dispatchTarget() ?? null;
  }
}
