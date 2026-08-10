import { describe, it, expect } from 'vitest';
import { ImrfmEntity } from '../src/entities/imrfm-entity.js';
import { ValidationError, IllegalTransition } from '../src/errors.js';

const VALID_ID = '3ddd8e04-1606-4ac8-8174-8321ee094278';
const SOFTWARE_VERSIONS = [{ moduleName: 'core', moduleVersion: '1.0.0' }];

describe('ImrfmEntity construction', () => {
  it('constructs with valid required fields', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme Robotics',
      softwareVersions: SOFTWARE_VERSIONS,
    });
    expect(entity.id).toBe(VALID_ID);
    expect(entity.manufacturerName).toBe('Acme Robotics');
    expect(entity.state).toBe('NOT_READY');
  });

  it('throws ValidationError on an invalid id', () => {
    expect(
      () =>
        new ImrfmEntity({
          id: 'not-a-uuid',
          manufacturerName: 'Acme',
          softwareVersions: SOFTWARE_VERSIONS,
        }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when manufacturerName is missing', () => {
    expect(
      () =>
        new ImrfmEntity({
          id: VALID_ID,
          manufacturerName: '',
          softwareVersions: SOFTWARE_VERSIONS,
        }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when softwareVersions is empty', () => {
    expect(
      () =>
        new ImrfmEntity({
          id: VALID_ID,
          manufacturerName: 'Acme',
          softwareVersions: [],
        }),
    ).toThrow(ValidationError);
  });
});

describe('ImrfmEntity state transitions', () => {
  it('allows transitions between all valid states', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme',
      softwareVersions: SOFTWARE_VERSIONS,
    });
    entity.setState('READY');
    expect(entity.state).toBe('READY');
    entity.setState('OFFLINE');
    expect(entity.state).toBe('OFFLINE');
    entity.setState('NOT_READY');
    expect(entity.state).toBe('NOT_READY');
  });

  it('throws IllegalTransition on an unknown state', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme',
      softwareVersions: SOFTWARE_VERSIONS,
    });
    expect(() => entity.setState('BOGUS')).toThrow(IllegalTransition);
    expect(entity.state).toBe('NOT_READY');
  });
});

describe('ImrfmEntity message serialization round-trip', () => {
  it('round-trips identity through toIdentityMessage/fromIdentityMessage', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme Robotics',
      softwareVersions: SOFTWARE_VERSIONS,
      imrfmModel: 'FleetMind-9000',
      iso21423Version: '1.0',
    });

    const message = entity.toIdentityMessage('2025-04-08T12:34:56.789Z');
    expect(message.entityType).toBe('IMRFM');

    const restored = ImrfmEntity.fromIdentityMessage(message);
    expect(restored.id).toBe(entity.id);
    expect(restored.manufacturerName).toBe(entity.manufacturerName);
    expect(restored.imrfmModel).toBe(entity.imrfmModel);
    expect(restored.iso21423Version).toBe(entity.iso21423Version);
    expect(restored.softwareVersions).toEqual(entity.softwareVersions);
  });

  it('produces a status message reflecting the current state', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme',
      softwareVersions: SOFTWARE_VERSIONS,
    });
    entity.setState('READY');

    expect(entity.toStatusMessage('2025-04-08T12:34:56.789Z')).toEqual({
      entityId: VALID_ID,
      timestamp: '2025-04-08T12:34:56.789Z',
      states: ['READY'],
    });
  });

  it('rejects an identity message with the wrong entityType', () => {
    const entity = new ImrfmEntity({
      id: VALID_ID,
      manufacturerName: 'Acme',
      softwareVersions: SOFTWARE_VERSIONS,
    });
    const message = entity.toIdentityMessage('2025-04-08T12:34:56.789Z');
    expect(() => ImrfmEntity.fromIdentityMessage({ ...message, entityType: 'IMR' })).toThrow(
      ValidationError,
    );
  });
});
