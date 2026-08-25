import { Iso21423Error } from '../errors.js';
import { PROTOCOL_VERSION } from '../types/constants.js';
import type { DetailState } from '../types/constants.js';
import type { Request, RequestDetail } from '../types/requests.js';
import { IncomingRequest } from './incomingRequest.js';
import type { EntityHandle } from './entityHandle.js';
import type { RequestKey } from './policies.js';
import {
  type ActionContext, type ActionHandler, type ActionResult, type StatusReason,
  type TypedRequestDetail,
} from './types.js';

/** States that block ordinary actions until cleared (decision 7). */
const BLOCKING_STATES = ['STOP_CATEGORY_0', 'STOP_CATEGORY_1', 'STOP_CATEGORY_2', 'WAIT_FOR_RESET'];
/** Action types exempt from the blocking-state check (decision 7) and from ACTION_NOT_IMPLEMENTED
 *  (cancelRequest is resolved by the executor itself, never dispatched to a handler). */
const STATE_EXEMPT_TYPES = new Set(['cancelRequest', 'pauseImr', 'resumeImr']);

const majorOf = (version: string): string => version.split('.')[0] ?? version;

/** Bookkeeping for one in-flight `run()`, keyed by (source, sequenceId) so a later cancelRequest can find it. */
interface ActiveRun {
  controller: AbortController;
  /** Set when a cancelRequest arrived while an atomic detail was executing (or otherwise). */
  cancelRequested: boolean;
}

type StepOutcome = { trigger: 'success' } | { trigger: 'abort' | 'cancel'; reason?: StatusReason; message?: string };

/** Groups detail indices into sequencing steps: a run of consecutive `blocking: false` details
 *  is one concurrent step; every `blocking: true` (default) detail is its own step. */
function groupSteps(details: readonly RequestDetail[]): number[][] {
  const steps: number[][] = [];
  let i = 0;
  while (i < details.length) {
    if (details[i]!.blocking === false) {
      const group: number[] = [];
      while (i < details.length && details[i]!.blocking === false) { group.push(i); i++; }
      steps.push(group);
    } else {
      steps.push([i]);
      i++;
    }
  }
  return steps;
}

/**
 * The per-action executor (ND-11.1): runs `EntityHandle.onRequest` handlers against admitted
 * requests, driving detail sequencing, atomic protection, cancelRequest resolution and recovery.
 * See task-7-brief.md for the exact behavior list.
 */
export class ActionExecutor {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly runs = new Map<string, ActiveRun>();

  /** Registers a handler for `type`; throws if one is already registered unless `override: true`. */
  register(type: string, handler: ActionHandler, opts?: { override?: true }): void {
    if (this.handlers.has(type) && !opts?.override) {
      throw new Iso21423Error(
        `onRequest: a handler for "${type}" is already registered — pass { override: true } to replace it`);
    }
    this.handlers.set(type, handler as ActionHandler);
  }

  hasHandlers(): boolean { return this.handlers.size > 0; }

  private runKey(source: string, sequenceId: number): string { return `${source}:${sequenceId}`; }

  /** Fires the AbortController for an admitted request the policy is preempting (Task 7 seam). */
  cancel(key: RequestKey): boolean {
    const run = this.runs.get(this.runKey(key.source, key.sequenceId));
    if (!run) return false;
    run.cancelRequested = true;
    run.controller.abort();
    return true;
  }

  /** Entry point called once a request is admitted (RequestServer step 6 fallback). The run stays
   *  registered in `this.runs` (so a cancelRequest can still find it) until the request is fully
   *  terminal — including through the RECOVERY phase (controller ruling: RECOVERY→CANCELED is
   *  legal, so a cancel arriving mid-recovery must still resolve). */
  async run(incoming: IncomingRequest, entity: EntityHandle): Promise<void> {
    const request = incoming.request;

    const preflight = this.preflightReject(request, entity);
    if (preflight) {
      await incoming.reject(preflight);
      return;
    }

    await incoming.accept();
    await incoming.updateStatus({ status: 'EXECUTING' });

    const key = this.runKey(request.source, request.sequenceId);
    const run: ActiveRun = { controller: new AbortController(), cancelRequested: false };
    this.runs.set(key, run);
    try {
      const outcome = await this.runSequence(request.details, request, entity, run, true, false,
        (index, patch) => incoming.updateDetailStatus({ index, ...patch }));

      if (outcome.trigger === 'success') {
        await incoming.complete({ status: 'SUCCEEDED' });
        return;
      }

      let trigger = outcome.trigger;
      let reason = outcome.reason;
      let message = outcome.message;
      if (request.recoveries && request.recoveries.length > 0) {
        await incoming.enterRecovery(request.recoveries, reason);
        // Controller ruling: recoveries are cleanup FOR the trigger, not a continuation of it —
        // the recovery phase starts with fresh cancel tracking (a new AbortController, and
        // cancelRequested reset) so only a *new* cancelRequest arriving during RECOVERY can stop
        // it early; the cancel/abort that got us into recovery must not immediately truncate it.
        run.controller = new AbortController();
        run.cancelRequested = false;
        const recoveryOutcome = await this.runSequence(
          request.recoveries, request, entity, run, false, true,
          (index, patch) => incoming.updateRecoveryStatus({ index, ...patch }));
        if (recoveryOutcome.trigger !== 'success') {
          // A new cancel during recovery reclassifies the final state to CANCELED even if the
          // original trigger was a plain abort; a recovery detail's own failure does not
          // reclassify a cancel-triggered run back to ABORTED (decision 8 unchanged).
          if (recoveryOutcome.trigger === 'cancel') trigger = 'cancel';
          reason = recoveryOutcome.reason ?? reason;
          message = recoveryOutcome.message ?? message;
        }
      }

      const finalStatus = trigger === 'cancel' ? 'CANCELED' : 'ABORTED';
      await incoming.complete({ status: finalStatus, reason, message });
    } finally {
      this.runs.delete(key);
    }
  }

  /** Runs one detail array (main details or recoveries) under the shared sequencing rules
   *  (item 3), atomic protection (item 4) and outcome mapping (item 5).
   *  - `allowSkipLastSuccess` lets the caller rely on the request-level terminal cascade for the
   *    very last detail of a clean success run (main details only).
   *  - `markRemainingCanceled`: recoveryStatuses is never cascaded by the request's terminal
   *    transition (unlike detailStatuses), so when the sequence stops early the caller must ask
   *    us to explicitly mark every not-yet-started item CANCELED (main details rely on the
   *    cascade instead and pass false here). */
  private async runSequence(
    items: readonly RequestDetail[], request: Request, entity: EntityHandle,
    run: ActiveRun, allowSkipLastSuccess: boolean, markRemainingCanceled: boolean,
    update: (index: number, patch: {
      status: DetailState; reason?: StatusReason; message?: string; properties?: Record<string, unknown>;
    }) => Promise<void>,
  ): Promise<StepOutcome> {
    const steps = groupSteps(items);
    for (let s = 0; s < steps.length; s++) {
      const group = steps[s]!;
      const results = await Promise.all(
        group.map((index) => this.runOneDetail(index, items[index]!, request, entity, run, update)));
      const batchHasAbort = results.some((r) => r.outcome === 'aborted');
      const cancelledNow = run.controller.signal.aborted || run.cancelRequested;
      for (let k = 0; k < group.length; k++) {
        const index = group[k]!;
        const result = results[k]!;
        const isLastOverall = index === items.length - 1;
        if (result.outcome === 'succeeded') {
          const skip = allowSkipLastSuccess && isLastOverall && !batchHasAbort && !cancelledNow;
          if (!skip) {
            await update(index, { status: 'SUCCEEDED', ...(result.properties ? { properties: result.properties } : {}) });
          }
        } else {
          await update(index, { status: 'ABORTED', reason: result.reason, ...(result.message ? { message: result.message } : {}) });
        }
      }
      if (batchHasAbort || cancelledNow) {
        if (markRemainingCanceled) {
          for (const index of steps.slice(s + 1).flat()) {
            await update(index, { status: 'CANCELED' });
          }
        }
        const aborted = results.find((r) => r.outcome === 'aborted');
        return cancelledNow
          ? { trigger: 'cancel', reason: aborted?.reason, message: aborted?.message }
          : { trigger: 'abort', reason: aborted?.reason, message: aborted?.message };
      }
    }
    return { trigger: 'success' };
  }

  /**
   * Runs a single detail's handler: publishes an EXECUTING status first, then invokes the
   * registered handler (or produces an ACTION_NOT_IMPLEMENTED result if none exists), catching any
   * thrown error as a GENERAL_FAILURE abort. Waits for any `ctx.progress()` updates issued during
   * the handler call to finish publishing before returning.
   */
  private async runOneDetail(
    index: number, detail: RequestDetail, request: Request, entity: EntityHandle,
    run: ActiveRun,
    update: (index: number, patch: {
      status: DetailState; reason?: StatusReason; message?: string; properties?: Record<string, unknown>;
    }) => Promise<void>,
  ): Promise<ActionResult> {
    const atomic = (detail.atomic ?? false) || (request.atomic ?? false);
    const signal = atomic ? new AbortController().signal : run.controller.signal;

    await update(index, { status: 'EXECUTING' });

    const pending: Promise<void>[] = [];
    const ctx: ActionContext = {
      entity, request, signal,
      progress: (properties) => { pending.push(update(index, { status: 'EXECUTING', properties })); },
      succeeded: (properties) => (properties !== undefined ? { outcome: 'succeeded', properties } : { outcome: 'succeeded' }),
      aborted: (reason, message) => (message !== undefined ? { outcome: 'aborted', reason, message } : { outcome: 'aborted', reason }),
    };

    const typed: TypedRequestDetail = { ...detail, properties: detail.properties ?? {} };
    const handler = this.handlers.get(detail.type);
    let result: ActionResult;
    try {
      if (!handler) {
        result = { outcome: 'aborted', reason: 'ACTION_NOT_IMPLEMENTED' };
      } else {
        result = await handler(typed, ctx);
      }
    } catch (err) {
      result = { outcome: 'aborted', reason: 'GENERAL_FAILURE', message: err instanceof Error ? err.message : String(err) };
    }
    await Promise.all(pending);
    return result;
  }

  /** Item 1: pre-flight rejection, first match wins across the four rule categories, each
   *  scanned over every detail in order. */
  private preflightReject(request: Request, entity: EntityHandle): StatusReason | undefined {
    for (const d of request.details) {
      if (d.format !== undefined && d.format !== 'ISO-21423') return 'FORMAT_NOT_SUPPORTED';
    }
    for (const d of request.details) {
      if (majorOf(d.version) !== majorOf(PROTOCOL_VERSION)) return 'VERSION_NOT_SUPPORTED';
    }
    for (const d of request.details) {
      if (d.type !== 'cancelRequest' && !this.handlers.has(d.type)) return 'ACTION_NOT_IMPLEMENTED';
    }
    const states = entity.lastStates();
    if (BLOCKING_STATES.some((s) => states.includes(s))) {
      for (const d of request.details) {
        if (!STATE_EXEMPT_TYPES.has(d.type)) return 'INVALID_IMR_STATE_FOR_ACTION';
      }
    }
    return undefined;
  }
}

/**
 * ND-11.1 / ND-12: cancelRequest is resolved by searching for the named (source, requestId) run
 * across a list of executors — never dispatched to an app handler. A plain client passes just its
 * own executor; the IMRFM's RequestServer additionally passes every managed handle's executor,
 * because a request it dispatched (ND-12) actually runs there, not in its own `runs` map.
 */
export async function resolveCancelRequest(
  cancelReq: IncomingRequest, executors: Iterable<ActionExecutor>,
): Promise<void> {
  const props = cancelReq.request.details[0]?.properties as
    { source?: string; requestId?: number } | undefined;
  const key = props?.source !== undefined && props.requestId !== undefined
    ? { source: props.source, sequenceId: props.requestId } : undefined;
  const found = key !== undefined && [...executors].some((ex) => ex.cancel(key));
  if (found) {
    // SUCCEEDED is only reachable from EXECUTING (Figure C.3) — the cancel op has no detail
    // work of its own to run, so step straight through ACCEPTED/EXECUTING.
    await cancelReq.accept();
    await cancelReq.updateStatus({ status: 'EXECUTING' });
    await cancelReq.complete({ status: 'SUCCEEDED' });
  } else {
    await cancelReq.reject('REJECTED');
  }
}
