import { describe, it, expect } from 'vitest';
import {
  Iso21423Client, EntityFilter, Iso21423Error, registerExtensionResource, isStandardResource,
  RESOURCE_CONFIG,
} from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR_UUID = '91403a21-7534-4467-99a6-79c46a130fe8';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const registration = {
  entityUuid: IMR_UUID, entityType: 'IMR', manufacturerName: 'Acme',
  capabilities: { provides: ['status', 'customData'], accepts: [] },
};

describe('extension resources', () => {
  it('rejects standard names, bad names and conflicting re-registration; tolerates identical re-registration', () => {
    expect(() => registerExtensionResource('odometry', { qos: 0, retain: false })).toThrow(Iso21423Error);
    expect(() => registerExtensionResource('bad/name', { qos: 0, retain: false })).toThrow(Iso21423Error);
    registerExtensionResource('vendorThing', { qos: 1, retain: true });
    registerExtensionResource('vendorThing', { qos: 1, retain: true });
    expect(() => registerExtensionResource('vendorThing', { qos: 0, retain: true })).toThrow(/different config/);
    expect(isStandardResource('odometry')).toBe(true);
    expect(isStandardResource('vendorThing')).toBe(false);
    expect(RESOURCE_CONFIG.vendorThing).toEqual({ qos: 1, retain: true });
  });

  it('publishes an extension resource on the entity namespace and delivers it raw to subscribers', async () => {
    registerExtensionResource('customData', { qos: 1, retain: false });
    const broker = new MemoryBroker();
    const robot = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
    const fleet = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
    const imr = await robot.registerSelfEntity(registration);

    const seen: { uuid: string; message: unknown }[] = [];
    await fleet.subscribeResource('customData', EntityFilter.entity(IMR_UUID),
      (ev) => seen.push({ uuid: ev.entityUuid, message: ev.message }));

    const payload = { timestamp: '2025-04-08T12:34:56.789Z', values: { echo: 'hello', battery_charging: 'true' } };
    await imr.publishExtension('customData', payload);
    await flush();

    expect(broker.messagesOn(`/ISO_21423/v1/IMR/${IMR_UUID}/customData`)[0]!.qos).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.uuid).toBe(IMR_UUID);
    expect(JSON.parse(seen[0]!.message as string)).toEqual(payload);   // raw text, no schema (ND-04)
  });

  it('refuses to publish an undeclared resource', async () => {
    const broker = new MemoryBroker();
    const robot = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
    const imr = await robot.registerSelfEntity(registration);
    await expect(imr.publishExtension('neverRegistered', {})).rejects.toThrow(/unknown resource/);
  });
});
