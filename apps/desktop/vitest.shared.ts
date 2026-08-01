import { fileURLToPath } from 'node:url'
import { defineProject, type ViteUserConfig } from 'vitest/config'
import { reactWithCompiler } from './react-compiler-plugin'

export function defineDesktopProject(project: {
  plugins?: ViteUserConfig['plugins']
  test: NonNullable<ViteUserConfig['test']>
  /** Extra module aliases (e.g. the browser project's loro-crdt wasm pin). */
  alias?: Record<string, string>
  optimizeDeps?: ViteUserConfig['optimizeDeps']
}): ViteUserConfig {
  return defineProject({
    plugins: [reactWithCompiler(), ...(project.plugins ?? [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        ...(project.alias ?? {}),
      },
    },
    ...(project.optimizeDeps ? { optimizeDeps: project.optimizeDeps } : {}),
    test: {
      globals: false,
      maxConcurrency: 1,
      retry: process.env.CI ? 3 : 0,
      setupFiles: ['./src/test-utils/setup-console.ts'],
      slowTestThreshold: 10_000,
      ...project.test,
    },
  })
}
