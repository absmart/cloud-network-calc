// Builds the API (api/index.ts and the src/lib code it uses) into one file in
// dist-api/, with the host.json and package.json Azure Functions needs, ready
// for Static Web Apps to deploy as managed functions without building.

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'api/index.ts',
    outDir: 'dist-api',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      // Provided by the Functions host at run time.
      external: ['@azure/functions-core'],
      output: { format: 'cjs', entryFileNames: 'index.js', inlineDynamicImports: true },
    },
  },
  // Bundle every dependency, so the deployed API needs no npm install.
  ssr: { noExternal: true, target: 'node' },
  plugins: [
    {
      name: 'functions-app-files',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'host.json', source: readFileSync('api/host.json', 'utf8') });
        this.emitFile({
          type: 'asset',
          fileName: 'package.json',
          source: `${JSON.stringify({ name: 'cloud-network-planner-api', private: true, main: 'index.js' }, null, 2)}\n`,
        });
      },
    },
  ],
});
