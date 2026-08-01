import { fileURLToPath } from 'node:url'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { reactWithCompiler } from './react-compiler-plugin'
// The single version source; tauri.conf.json's `version` also points here.
import pkg from './package.json'

// @ts-expect-error process is a Node.js global available in the Vite config context
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    reactWithCompiler(),
    tailwindcss(),
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: 'reflect-64',
      project: 'reflect-open',
      telemetry: false,
      release: {
        name: `reflect@${pkg.version}`,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ],

  define: {
    __REFLECT_VERSION__: JSON.stringify(pkg.version),
  },

  // If the target is below Safari 17.5, Lightning CSS downlevels `light-dark()` to a broken polyfill.
  build: { cssTarget: 'safari17.5', sourcemap: 'hidden' },

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Pin loro-crdt to its self-loading `browser` build: the dev-mode
      // `development` condition would otherwise pick the `bundler` build,
      // whose raw `.wasm` import Vite can't serve (see optimizeDeps below).
      'loro-crdt': 'loro-crdt/browser',
    },
  },

  // Expose the Tauri CLI's build-time TAURI_ENV_* vars (e.g. the target
  // platform, which gates desktop-only surfaces like the updater).
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  // The dev bridge's SQLite (dev-only, behind `?platform=ios`) locates its
  // .wasm relative to its own module URL; esbuild pre-bundling would relocate
  // the module into .vite/deps and break that lookup. loro-crdt's `browser`
  // build (pinned via the alias above — the dev-condition `bundler` build's
  // raw `.wasm` import doesn't work under Vite) resolves its wasm the same
  // way, so it stays out too. loro-prosemirror must NOT be excluded: it
  // would then load a source-served prosemirror-state while the editor uses
  // the prebundled copy — two Plugin classes, failing ProseKit's checks.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', 'loro-crdt'],
  },

  // Vite options tailored for Tauri development, applied in `tauri dev`/`tauri build`.
  //
  // 1. prevent Vite from obscuring Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if it is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}))
