// The one path a live testnet can't show on demand: BTC actually touching a strike.
// Runs the app against an anvil fork of Mezo testnet with the real Payung vault and the real MUSD
// system. The only change is the BTC price: Mezo's oracle is a chain precompile anvil can't
// execute, so PriceFeed's code is swapped for one that returns a price we set (the same trick as
// the Foundry fork tests). Then the UI triggers the touched strike (earning the reward) and pays
// the policy into the real trove.
//   E2E_KEY=0x... npx playwright test touch
import { test, expect } from '@playwright/test'
import { spawn, execSync } from 'node:child_process'
import { createPublicClient, http, parseUnits, numberToHex, pad } from 'viem'
import { installWallet } from './wallet.mjs'
import { mezoTestnet, ADDR, payungAbi, mezoAbi } from '../shared/mezo.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY
const RPC = 'http://127.0.0.1:8786'
const APP = 'http://localhost:4784/'
const RETURN_SLOT0 = '0x60005460005260206000f3' // runtime: return sload(0) for any call
const procs = []

const start = (cmd, env = {}) => {
  const p = spawn(cmd, { shell: true, stdio: 'ignore', env: { ...process.env, ...env } })
  procs.push(p)
  return p
}
const until = async (fn, ms = 120_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    try {
      if (await fn()) return
    } catch {}
  }
  throw new Error('timed out waiting')
}

test.describe('a BTC touch on a fork of Mezo testnet', () => {
  test.skip(!KEY, 'set E2E_KEY (the key that holds the demo policy)')
  const fork = createPublicClient({ chain: mezoTestnet, transport: http(RPC) })
  const setPrice = (usd) => fork.request({ method: 'anvil_setStorageAt', params: [ADDR.priceFeed, '0x0', pad(numberToHex(parseUnits(usd, 18)))] })

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    // A leftover fork or server on these ports would carry old state; refuse rather than test it.
    for (const url of [RPC, APP]) {
      const busy = await fetch(url).then(() => true, () => false)
      if (busy) throw new Error(`${url} is already in use; stop that process first`)
    }
    start(`anvil --fork-url https://rpc.test.mezo.org --port 8786 --chain-id 31611 --silent`)
    await until(() => fork.getBlockNumber())
    await fork.request({ method: 'anvil_mine', params: ['0x1'] }) // Mezo headers lack blob-gas fields; a local block has them
    await fork.request({ method: 'anvil_setCode', params: [ADDR.priceFeed, RETURN_SLOT0] })
    execSync('npx vite build --outDir dist-fork', { cwd: 'app', stdio: 'ignore', env: { ...process.env, VITE_MEZO_RPC: RPC } })
    start('npm run preview -w app -- --outDir dist-fork --port 4784 --strictPort')
    await until(async () => (await fetch(APP)).ok)
  })

  test.afterAll(() => {
    for (const p of procs) {
      try {
        if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' })
        else p.kill()
      } catch {}
    }
  })

  test('touch, trigger for the reward, pay into the real trove', async ({ page }) => {
    test.setTimeout(600_000)
    page.on('console', (m) => m.type() === 'warning' && console.log('PAGE', m.text().slice(0, 300)))
    const w = await installWallet(page, KEY, RPC)
    const me = w.account.address
    // Fork-only gas money: anvil suggests a 1 gwei tip where Mezo charges ~150 wei.
    await fork.request({ method: 'anvil_setBalance', params: [me, numberToHex(10n ** 18n)] })
    // The holder's live auto-repay policy with the highest strike: a touch there leaves the loan
    // above 110% after the payout, so Mezo accepts the repay (the app warns when it wouldn't).
    const ids = await fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [me] })
    const all = await Promise.all(ids.map(async (id) => ({ id, ...(await fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policy', args: [id] })) })))
    const now = BigInt(Math.floor(Date.now() / 1000))
    const policy = all.filter((p) => p.autoRepay && !p.claimed && p.expiry > now).sort((a, b) => (b.strike > a.strike ? 1 : b.strike < a.strike ? -1 : Number(b.id - a.id)))[0]
    const ends = new Date(Number(policy.expiry) * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    const strikeUsd = Number(policy.strike / 10n ** 18n)

    await setPrice(String(strikeUsd - 500)) // BTC dips $500 under the strike
    await page.goto(APP)
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await expect(page.locator('.acct')).toBeVisible()
    await expect(page.getByRole('img', { name: new RegExp(`BTC \\$${(strikeUsd - 500).toLocaleString('en-US')}`) })).toBeVisible()

    // Make sure the payout can land in the loan: if an earlier signed Mezo action used up the
    // nonce this policy was signed with, the app shows Re-sign; use it.
    await page.getByRole('button', { name: 'My cover' }).click()
    const row = page.locator('tbody tr', { hasText: ends }).filter({ hasText: `$${strikeUsd.toLocaleString('en-US')}` }).filter({ hasText: `${policy.cover / 10n ** 18n} MUSD` }).first()
    await expect(row).not.toContainText('checking the repay', { timeout: 300_000 })
    if (await row.getByRole('button', { name: 'Re-sign' }).isVisible()) {
      await row.getByRole('button', { name: 'Re-sign' }).click()
      await expect(page.getByRole('status')).toContainText('Auto-repay re-signed', { timeout: 300_000 })
    }

    // Underwrite tab offers the trigger to anyone, with its reward.
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    // Every strike BTC is under gets its own trigger offer; take the one this policy sits on.
    const trigger = page
      .locator('.banner p', { hasText: `the $${strikeUsd.toLocaleString('en-US')} strike` })
      .filter({ hasText: `ending ${ends}` })
      .getByRole('button', { name: /Trigger it and earn/ })
    await expect(trigger).toBeVisible()
    const [strikeCover] = await fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'strikes', args: [policy.expiry, policy.strike] })
    const expected = await fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'triggerReward', args: [strikeCover] })
    const musdBefore = await fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [me] })
    await trigger.click()
    await expect(page.getByRole('status')).toContainText(`Triggered $${strikeUsd.toLocaleString('en-US')}`)
    const reward = (await fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [me] })) - musdBefore
    expect(reward).toBe(expected) // 0.1% of the strike's cover, paid to whoever triggered
    await expect(trigger).toBeHidden()

    // My cover: touched, and the holder pays it out without waiting for a keeper.
    await page.getByRole('button', { name: 'My cover' }).click()
    await expect(row).toContainText('Touched, paying out')
    const [, principalBefore, interestBefore] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [me] })
    await row.getByRole('button', { name: 'Pay out now' }).click()
    await expect(page.getByRole('status')).toContainText('into your loan', { timeout: 240_000 }) // a fork reads every slot over RPC
    await expect(row).toContainText('Paid', { timeout: 120_000 })
    const [, principalAfter, interestAfter] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [me] })
    const repaid = principalBefore + interestBefore - (principalAfter + interestAfter)
    expect(repaid > policy.cover - 10n ** 15n && repaid <= policy.cover).toBe(true) // the trove's debt fell by the cover
  })
})
