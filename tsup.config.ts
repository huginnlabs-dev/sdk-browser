import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  globalName: 'dataflow',
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'browser',
  splitting: false,
  outExtension(ctx) {
    if (ctx.format === 'cjs') return { js: '.cjs' };
    if (ctx.format === 'iife') return { js: '.iife.js' };
    return { js: '.js' };
  },
});
