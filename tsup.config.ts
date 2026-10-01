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
  // rrweb stays OUT of every bundle: src/replay.ts imports it dynamically and
  // the host bundler / Node resolves it at runtime. The IIFE (script tag) build
  // cannot resolve a bare specifier, so there replay degrades silently unless
  // the page provides an import map. tsup force-bundles deps into IIFE, so the
  // exclusion is re-asserted per format via esbuildOptions.
  external: ['rrweb'],
  esbuildOptions(options, context) {
    if (context.format === 'iife') options.external = ['rrweb'];
    return options;
  },
  outExtension(ctx) {
    if (ctx.format === 'cjs') return { js: '.cjs' };
    if (ctx.format === 'iife') return { js: '.iife.js' };
    return { js: '.js' };
  },
});
