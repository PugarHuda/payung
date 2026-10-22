// End-to-end tests against the real Mezo testnet: the browser wallet is a bridge to a local
// viem account (E2E_KEY), so every click sends real transactions to the deployed vault.
//   E2E_KEY=0x... npx playwright test
import { defineConfig } from '@playwright/test'

// With RELAYER_KEY set, the app is built against a local copy of the relayer (e2e/passport.spec.mjs).
const RELAY = !process.env.E2E_URL && process.env.RELAYER_KEY
if (RELAY) process.env.VITE_RELAY_URL ??= 'http://localhost:4790/api/relay'

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1, // one wallet, one nonce sequence
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:4783/',
    trace: 'retain-on-failure',
  },
  // The read-only suite also runs in Firefox and WebKit (Safari's engine: most iPhone borrowers).
  projects: [
    { name: 'chromium', use: { channel: process.env.E2E_CHANNEL ?? 'msedge' } }, // Edge ships with Windows; CI uses chromium
    { name: 'firefox', use: { browserName: 'firefox' }, grep: /without a wallet/ },
    { name: 'webkit', use: { browserName: 'webkit' }, grep: /without a wallet/ },
  ],
  webServer: process.env.E2E_URL ? undefined : [
    { command: 'npm run build && npm run preview -w app -- --port 4783 --strictPort', url: 'http://localhost:4783/', timeout: 120_000 },
    // Payung's relayer for Bitcoin wallets (api/relay.js), served locally when there is a key for it.
    ...(RELAY ? [{ command: 'node e2e/relay-server.mjs 4790', url: 'http://localhost:4790/api/relay', timeout: 30_000 }] : []),
  ],
})
