import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

const SUBPATHS = ['.', './types', './schema', './topics', './geometry', './session', './core',
  './gateway', './testing'];

describe('package layout (nodejs_api.md §2, ND-19)', () => {
  it('declares every documented subpath with CJS, ESM and types', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; import: string; require: string }>;
      peerDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    for (const sub of SUBPATHS) {
      expect(Object.keys(pkg.exports)).toContain(sub);
      const entry = pkg.exports[sub]!;
      expect(entry.types.endsWith('.d.ts')).toBe(true);
      expect(entry.import.endsWith('.js')).toBe(true);
      expect(entry.require.endsWith('.cjs')).toBe(true);
    }
    expect(pkg.peerDependencies.mqtt).toBe('^5.0.0');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ajv', 'ajv-formats', 'uuid']);
  });

  it('keeps the root entry free of top-level await (CJS constraint)', async () => {
    const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*await /m);
  });
});
