import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  outfile: 'dist/cli.js',
  // Let esbuild's node platform handle built-in resolution.
  // node-fetch uses CJS require("stream") etc., so we need the
  // banner shim to make require() work in ESM output.
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
  // Alias 'punycode' to the userland package so dependencies don't
  // hit Node's deprecated built-in at runtime.
  alias: {
    punycode: 'punycode/',
  },
});
