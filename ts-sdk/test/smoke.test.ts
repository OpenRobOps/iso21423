import { describe, it, expect } from 'vitest';
import { SDK_NAME } from '../src/index.js';

describe('package skeleton', () => {
  it('exposes the package entry', () => {
    expect(SDK_NAME).toBe('@openrobops/iso21423');
  });
});
