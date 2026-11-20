// @ts-check
const { defineConfig } = require('@playwright/test');

// Load CDSS_URL etc. from .env if present (never commit .env - see .env.example)
try { process.loadEnvFile(); } catch { /* no .env file */ }
if (!process.env.CDSS_URL) throw new Error('CDSS_URL is not set. Copy .env.example to .env and fill it in.');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: Number(process.env.WORKERS || 4),
  retries: 0, // stuck runs are retried inside the test with a fresh ref_id
  timeout: 8 * 60 * 1000,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalTeardown: require.resolve('./src/report.js'),
  use: {
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'single', testMatch: 'single.spec.js' },
    { name: 'double', testMatch: 'double.spec.js' },
    { name: 'triple', testMatch: 'triple.spec.js' },
  ],
});
