import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import { Iso21423Client, move } from '../../src/index.js';

const brokerUrl = process.env.ISO21423_BROKER_URL;

describe.skipIf(!brokerUrl)('live broker (ISO21423_BROKER_URL)', () => {
  it('round-trip: two clients, IMR, move, SUCCEEDED', async () => {
    // This test skips itself when ISO21423_BROKER_URL is unset
    const robotId = uuid();
    const senderId = uuid();

    const robotClient = await Iso21423Client.connect({ url: brokerUrl! });
    const senderClient = await Iso21423Client.connect({ url: brokerUrl! });

    try {
      // Register robot (IMR) with move capability
      const robot = await robotClient.registerSelfEntity({
        entityUuid: robotId,
        entityType: 'mobile robot',
        manufacturerName: 'test-robot',
        capabilities: { accepts: ['move'] },
      });

      // Register sender (controller)
      const sender = await senderClient.registerSelfEntity({
        entityUuid: senderId,
        entityType: 'controller',
        manufacturerName: 'test-sender',
      });

      // Set up move handler that immediately succeeds
      robot.onRequest('move', async (_details, ctx) => ctx.succeeded());

      // Send a move request
      const req = await sender.sendRequest({
        destination: robotId,
        details: [move({
          location: {
            ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', // arbitrary CCS for smoke test
            x: 1.0, y: 2.0, z: 0.0,
          },
        })],
      });

      // Wait for completion
      const completion = await req.completion();
      expect(completion.status).toBe('SUCCEEDED');
    } finally {
      // Clean up
      await robotClient.close?.();
      await senderClient.close?.();
    }
  });
});
