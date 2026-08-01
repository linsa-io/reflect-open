import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { playwrightCommands } from 'vitest-browser-commands'
import { defineDesktopProject } from './vitest.shared'

const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

if (process.env.CI) {
  console.log('Running in CI mode with browser:', browserName)
}

export default defineDesktopProject({
  plugins: [tailwindcss(), playwrightCommands()],
  // Dev-mode module conditions would pick loro-crdt's `bundler` build, whose
  // raw `.wasm` import Vite can't serve; the `browser` build self-loads its
  // wasm relative to `import.meta.url`, which also rules out esbuild
  // prebundling relocating it (same story as @sqlite.org/sqlite-wasm). Only
  // loro-crdt is excluded: excluding loro-prosemirror too would give it a
  // source-served prosemirror-state while the editor uses the prebundled
  // copy — two Plugin classes, and ProseKit's `instanceof` checks fail.
  alias: { 'loro-crdt': 'loro-crdt/browser' },
  optimizeDeps: { exclude: ['loro-crdt'] },
  test: {
    name: 'browser',
    include: ['src/**/*.test.tsx'],
    sequence: { groupOrder: 100 },
    setupFiles: ['./src/test-utils/setup-console.ts', './src/test-utils/setup-browser.ts'],
    // Real keyboard focus is a per-page global; parallel test files
    // would steal it from each other.
    fileParallelism: false,
    browser: {
      enabled: true,
      viewport: { width: 900, height: 600 },
      provider: playwright({
        contextOptions: {
          reducedMotion: 'reduce',
          hasTouch: true,
          permissions:
            browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : undefined,
        },
      }),
      headless: !process.env.DEBUG,
      instances: [{ browser: browserName }],
    },
  },
})
