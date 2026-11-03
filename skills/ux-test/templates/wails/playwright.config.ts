import { defineConfig, devices } from '@playwright/test'

// Wails target: tests drive `wails dev` through its browser bridge, where Go
// bindings work over a WebSocket. The native window must stay open for the run.
export default defineConfig({
  testDir: './e2e',
  // Kept inside e2e/ so e2e/.gitignore covers it; the root .gitignore is not ours.
  outputDir: './e2e/test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://__DEV_SERVER__',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'wails dev',
    url: 'http://__DEV_SERVER__',
    reuseExistingServer: true,
    timeout: 180_000,
    // wails dev runs its frontend watcher in its own process group, so the
    // default kill leaves Vite holding the pipe and the run never exits.
    // Ctrl-C lets wails dev stop the watcher itself.
    gracefulShutdown: { signal: 'SIGINT', timeout: 10_000 },
  },
})
