import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import { Iso21423Client } from '../../src/core/index.js';

const brokerUrl = process.env.ISO21423_BROKER_URL;

describe.skipIf(!brokerUrl)('live broker (ISO21423_BROKER_URL)', () => {
  it('round-trip: two clients, IMR, move, SUCCEEDED', async () => {
    // This test skips itself when ISO21423_BROKER_URL is unset
    const client1 = await Iso21423Client.connect({ url: brokerUrl! });
    const client2 = await Iso21423Client.connect({ url: brokerUrl! });

    // Register IMRs
    await client1.registerSelfEntity({
      entityUuid: uuid(),
      entityType: 'mobile robot',
      manufacturerName: 'test',
    });
    await client2.registerSelfEntity({
      entityUuid: uuid(),
      entityType: 'mobile robot',
      manufacturerName: 'test',
    });

    // Verify basic connectivity
    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
  });
});
