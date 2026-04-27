import { build } from 'esbuild';

await build({
  entryPoints: ['src/serve.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/serve.js',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
});

console.log('Build complete: dist/serve.js');
