// End-to-end tests against the real Mezo testnet: the browser wallet is a bridge to a local
// viem account (E2E_KEY), so every click sends real transactions to the deployed vault.
//   E2E_KEY=0x... npx playwright test
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1, // one wallet, one nonce sequence
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:4783/',
    channel: process.env.E2E_CHANNEL ?? 'msedge', // Edge ships with Windows; CI uses chromium
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_URL ? undefined : { command: 'npm run build && npm run preview -w app -- --port 4783 --strictPort', url: 'http://localhost:4783/', timeout: 120_000 },
})
