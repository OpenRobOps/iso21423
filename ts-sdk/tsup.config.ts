import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types/index.ts',
    schema: 'src/schema/index.ts',
    topics: 'src/topics/index.ts',
    geometry: 'src/geometry/index.ts',
    session: 'src/session/index.ts',
    core: 'src/core/index.ts',
    gateway: 'src/gateway/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  sourcemap: true,
  clean: true,
});
