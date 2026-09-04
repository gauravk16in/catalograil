/**
 * drizzle-kit loads the schema through a CJS require, which will not resolve the
 * `.js` extensions that correct Node ESM source needs. Rather than strip those from
 * the schema files, bundle them into a single CJS module for drizzle-kit to read.
 *
 * `drizzle-orm` stays external on purpose: drizzle-kit identifies tables by their
 * class identity, so it and the bundle must share one copy of the library.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/schema/index.ts'],
  outfile: '.drizzle/schema.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['drizzle-orm'],
  logLevel: 'warning',
});

console.log('Bundled schema for drizzle-kit → .drizzle/schema.cjs');
