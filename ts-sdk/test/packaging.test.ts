/**
 * Copyright 2026 InOrbit, Inc.
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

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
