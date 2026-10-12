import { defineConfig } from 'tsdown';

const shared = {
  platform: 'node' as const,
  target: 'node18',
  fixedExtension: true,
  tsconfig: 'tsconfig.json',
  dts: true,
  sourcemap: true,
  deps: { neverBundle: true as const },
};

export default defineConfig([
  { ...shared, entry: { index: 'src/index.ts' }, format: 'esm', clean: true },
  // A default-only entry: tsdown emits `module.exports = archiver` and `export = archiver`.
  {
    ...shared,
    entry: { index: 'src/commonjs.ts' },
    format: 'cjs',
    clean: false,
    publint: { strict: true },
    attw: { level: 'error' as const },
  },
]);
