import { validate as isUuid } from 'uuid';
import { IllegalTransition, ValidationError } from '../errors.js';
import type { Capabilities, EntityIdentity, ImrfmDetails } from '../types/identity.js';
import type { EntityStatus, ImrfmOperatingState } from '../types/status.js';
import { IMRFM_OPERATING_STATES } from '../types/status.js';
import type { IsoTimestamp, SoftwareVersion, Uuid } from '../types/common.js';

export interface ImrfmEntityInit {
  id: Uuid;
  manufacturerName: string;
  softwareVersions: SoftwareVersion[];
  imrfmModel?: string;
  iso21423Version?: string;
  capabilities?: Capabilities;
}

const DEFAULT_CAPABILITIES: Capabilities = {
  provides: ['identity', 'status'],
  accepts: { requests: [] },
};

/**
 * Domain entity for an IMRFM (fleet manager) per ISO 21423 clauses 7-8.
 * Pure protocol logic — no MQTT/transport involved (that's Task 2/gateway work).
 */
export class ImrfmEntity {
  readonly id: Uuid;
  readonly manufacturerName: string;
  readonly imrfmModel?: string;
  readonly iso21423Version?: string;
  readonly softwareVersions: SoftwareVersion[];
  readonly capabilities: Capabilities;
  private _state: ImrfmOperatingState;

  constructor(init: ImrfmEntityInit) {
    if (!init.id || !isUuid(init.id)) {
      throw new ValidationError(`ImrfmEntity requires a valid UUID id, got: ${String(init.id)}`);
    }
    if (!init.manufacturerName) {
      throw new ValidationError('ImrfmEntity requires a non-empty manufacturerName');
    }
    if (!init.softwareVersions || init.softwareVersions.length === 0) {
      throw new ValidationError('ImrfmEntity requires at least one softwareVersions entry');
    }

    this.id = init.id;
    this.manufacturerName = init.manufacturerName;
    this.imrfmModel = init.imrfmModel;
    this.iso21423Version = init.iso21423Version;
    this.softwareVersions = init.softwareVersions;
    this.capabilities = init.capabilities ?? DEFAULT_CAPABILITIES;
    this._state = 'NOT_READY';
  }

  get state(): ImrfmOperatingState {
    return this._state;
  }

  setState(next: string): void {
    if (!(IMRFM_OPERATING_STATES as readonly string[]).includes(next)) {
      throw new IllegalTransition(
        `Invalid IMRFM state "${next}" — must be one of ${IMRFM_OPERATING_STATES.join(', ')}`,
      );
    }
    this._state = next as ImrfmOperatingState;
  }

  toIdentityMessage(timestamp: IsoTimestamp): EntityIdentity {
    const details: ImrfmDetails = {
      imrfmModel: this.imrfmModel,
      softwareVersions: this.softwareVersions,
    };
    return {
      id: this.id,
      timestamp,
      entityType: 'IMRFM',
      manufacturerName: this.manufacturerName,
      iso21423Version: this.iso21423Version,
      capabilities: this.capabilities,
      details,
    };
  }

  toStatusMessage(timestamp: IsoTimestamp): EntityStatus {
    return { entityId: this.id, timestamp, states: [this._state] };
  }

  static fromIdentityMessage(message: EntityIdentity): ImrfmEntity {
    if (message.entityType !== 'IMRFM') {
      throw new ValidationError(`Expected entityType "IMRFM", got "${message.entityType}"`);
    }
    const details = message.details as ImrfmDetails;
    return new ImrfmEntity({
      id: message.id,
      manufacturerName: message.manufacturerName,
      softwareVersions: details.softwareVersions,
      imrfmModel: details.imrfmModel,
      iso21423Version: message.iso21423Version,
      capabilities: message.capabilities,
    });
  }
}
