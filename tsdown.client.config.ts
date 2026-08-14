/**
 * Client bundle build (mirrors the official clientConfig preset and the
 * community dsh-web-plugin-manager approach): the bundle is CJS wrapped in a
 * __ModuleLoader__.load({ id, factory }) handoff — the client-modules
 * contract. React and official client platform packages ride the module table
 * (external); everything else inlines.
 */
import { defineConfig } from 'tsdown'

const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig({
  name: 'dsh-hotplug-engine/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Types ship from tsc (tsconfig.client.json); dts here would wrap the
  // banner/footer into .d.cts and break parsing (official note).
  dts: false,
  clean: false,
  sourcemap: false,
  external: PLATFORM,
  noExternal: (id: string) => (PLATFORM.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The handoff: register this bundle's factory with the client-modules
    // loader; externals resolve through the injected require (module table).
    banner: 'window.__ModuleLoader__.load({ id: "dsh-hotplug-engine", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
