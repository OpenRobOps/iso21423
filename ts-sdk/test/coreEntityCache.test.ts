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
