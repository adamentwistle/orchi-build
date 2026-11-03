import { defineConfig, devices } from '@playwright/test'

// Next target: tests drive `next dev` on port 3000. The same webServer block runs
// locally and in .github/workflows/ux-test.yml.
export default defineConfig({
  testDir: './e2e',
  // Kept inside e2e/ so e2e/.gitignore covers it; the root .gitignore is not ours.
  outputDir: './e2e/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // CI also writes the HTML report, which the workflow uploads when a run fails.
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './e2e/playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx next dev --port 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    // The first request compiles the route, which is slow on a cold CI runner.
    timeout: 180_000,
  },
})
