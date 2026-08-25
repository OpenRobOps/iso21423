import { ROOT_NAMESPACE } from '../types/constants.js';
import type { Uuid } from '../types/common.js';
import type { Request } from '../types/requests.js';

/** One filter clause; an omitted field means "any" (compiles to an MQTT `+` wildcard). */
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

  /** One MQTT topic filter per selector, for subscribing to `resource` across every entity this filter selects. */
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

/** Shared base for filters that subscribe to a fixed topic suffix (e.g. `request/+`) across a set of entity selectors. */
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
