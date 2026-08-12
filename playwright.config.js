import { defineConfig } from '@playwright/test';

const chromiumChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/serve-static.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: chromiumChannel, viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', channel: chromiumChannel, viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
});
