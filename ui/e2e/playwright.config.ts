/**
 * `make e2e`: the app's golden paths in Playwright's own headless shell
 * against a sandboxed daemon (ui/e2e/stand.ts, .ai/10-infrastructure.md § E2E).
 *
 * The browser is always the chromium-headless-shell Playwright installed
 * (`npx playwright install chromium-headless-shell`): never the system
 * Chrome, never a `channel`, never a connection to a running browser.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  // One stand, shared: the scenarios run one after another so two of them
  // never type into the same session at once.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : 'list',
  outputDir: 'results',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-headless-shell', use: { browserName: 'chromium' } }],
})
