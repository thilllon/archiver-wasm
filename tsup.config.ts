// tsup.config.ts (scaffold unit, verbatim)
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  target: 'node18',
  platform: 'node',
  dts: true,
  shims: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
});
