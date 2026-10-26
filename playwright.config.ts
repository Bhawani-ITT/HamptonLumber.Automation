import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { STORAGE_STATE_PATH } from './utils/constants';

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* One test at a time: the load tests log in up to 50 shared users each, and stage can't take two of them at once. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html'],
    /* One self-contained HTML file to share: shareable-report/test-report.html */
    ['./reporters/shareable-report.ts', { outputFile: 'shareable-report/test-report.html' }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: process.env.BASE_URL ?? 'https://your-hamptonlumber-app-url.com',

    /* Traces record typed passwords and auth cookies, so they are never produced on CI where reports are uploaded. */
    trace: process.env.CI ? 'off' : 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      testDir: './auth',
    },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE_PATH },
      dependencies: ['setup'],
    },

    {
      name: 'google-chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', storageState: STORAGE_STATE_PATH },
      dependencies: ['setup'],
    },

    {
      name: 'microsoft-edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge', storageState: STORAGE_STATE_PATH },
      dependencies: ['setup'],
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
