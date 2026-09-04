import { defineConfig } from '@playwright/test';

/**
 * S7.1 — end to end against a **deployed** environment, not localhost.
 *
 * Running against a dev server would test the code and skip everything that actually broke
 * in this project: CORS, the authorizer, the static export's routing, the build-time
 * environment variables. Every bug in `docs/DIAGNOSIS.md` was invisible locally and obvious
 * against the deployment.
 *
 * The API journeys need no browser and run anywhere; the UI journeys need `MERCHANT_APP_URL`
 * and are skipped without it, so CI can run the useful half before the dashboards deploy.
 */
export default defineConfig({
  testDir: './tests',
  // Deployed infrastructure has real latency, and Aurora Serverless resumes from zero ACU.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: process.env.MERCHANT_APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
