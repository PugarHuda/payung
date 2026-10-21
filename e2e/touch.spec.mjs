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
import { readAlerts } from '../shared/notify.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY
const RPC = 'http://127.0.0.1:8786'
const APP = 'http://localhost:4784/'
// anvil's first dev account, funded on every fork: plays an outside keeper
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ANVIL_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const RETURN_SLOT0 ='0x60005460005260206000f3' // runtime: return sload(0) for any call
const procs = []
const APP_NTFY = `payung-e2e-app-${Date.now().toString(36)}-` // the app's alerts in this run's own ntfy namespace

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
    execSync('npx vite build --outDir dist-fork', { cwd: 'app', stdio: 'ignore', env: { ...process.env, VITE_MEZO_RPC: RPC, VITE_NTFY_PREFIX: APP_NTFY } })
    start('npm run preview -w app -- --outDir dist-fork --port 4784 --strictPort', { VITE_MEZO_RPC: RPC }) // CSP lets the app reach the fork
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

  // The keeper is what pays people who aren't watching: run the real keeper.mjs against the fork
  // and check it triggers every touched strike and pays every policy on them. Reverted afterwards,
  // so the app test below starts from the same state.
  test('the keeper triggers and pays a touch on its own', async () => {
    test.setTimeout(600_000)
    const snapshot = await fork.request({ method: 'evm_snapshot' })
    try {
      const read = (functionName, args = []) => fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName, args })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const count = await read('policyCount')
      const live = []
      for (let id = 0n; id < count; id++) {
        const p = await read('policy', [id])
        if (!p.claimed && p.expiry > now) live.push({ id, ...p })
      }
      expect(live.length).toBeGreaterThan(0)
      const top = live.reduce((a, b) => (b.strike > a.strike ? b : a)).strike
      await setPrice(String(Number(top / 10n ** 18n) - 500)) // only the highest live strike is touched
      const touched = live.filter((p) => p.strike === top)
      const before = await Promise.all(touched.map((p) => fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [p.holder] })))
      const walletBefore = await Promise.all(touched.map((p) => fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [p.holder] })))
      const keeperBefore = await fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [ANVIL_ADDR] })

      // Phone alerts go to real ntfy.sh, in a namespace of this run's own (not the holders' real topics).
      const NTFY_PREFIX = `payung-e2e-${Date.now().toString(36)}-`
      const keeperFrom = await fork.getBlockNumber()
      const out = execSync('node keeper/keeper.mjs --once', { env: { ...process.env, KEEPER_KEY: ANVIL_KEY, MEZO_RPC: RPC, NTFY_PREFIX }, encoding: 'utf8' })
      console.log(out.trim())

      let reward = 0n
      for (const e of new Set(touched.map((p) => p.expiry))) {
        const [cover, triggered] = await read('strikes', [e, top])
        expect(triggered).toBe(true)
        reward += await read('triggerReward', [cover])
      }
      const keeperAfter = await fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [ANVIL_ADDR] })
      expect(keeperAfter - keeperBefore).toBe(reward) // the keeper earns the trigger reward
      for (const [i, p] of touched.entries()) {
        expect((await read('policy', [p.id])).claimed).toBe(true)
        // Paid into the loan (debt falls by the cover) or, when Mezo can't take the repay, to the wallet.
        const [, principal, interest] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [p.holder] })
        const repaid = before[i][1] + before[i][2] - (principal + interest)
        const toWallet = (await fork.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [p.holder] })) - walletBefore[i]
        expect(repaid + toWallet).toBeGreaterThanOrEqual(p.cover - 10n ** 15n)
        if (p.autoRepay && !out.includes(`policy ${p.id}: repay would fail`)) expect(repaid).toBeGreaterThanOrEqual(p.cover - 10n ** 15n)
        // The holder's phone got the payout alert, signed by the keeper, saying where the MUSD went.
        const paidAlert = async () => (await readAlerts(p.holder, NTFY_PREFIX)).find((a) => a.tag === `paid-${ADDR.payung.toLowerCase()}-${p.id}`)
        await expect.poll(async () => (await paidAlert())?.signer, { message: `no keeper-signed payout alert for policy ${p.id}`, timeout: 15_000 }).toBe(ANVIL_ADDR)
        const alert = await paidAlert()
        // A holder can have several policies on the strike, so read where this one went from its own event.
        const [paid] = await fork.getContractEvents({ address: ADDR.payung, abi: payungAbi, eventName: 'PolicyPaid', args: { id: p.id }, fromBlock: keeperFrom })
        expect(alert.message).toMatch(paid.args.repaidTrove ? /into your Mezo loan/ : /to your wallet/)
      }
    } finally {
      await fork.request({ method: 'evm_revert', params: [snapshot] })
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
    // Phone alerts: the topic shown is the holder's, and a test alert really reaches ntfy.sh.
    const topic = `${APP_NTFY}${me.toLowerCase().slice(2)}`
    await expect(page.locator('.phone code')).toHaveText(topic)
    await page.getByRole('button', { name: 'Send a test alert' }).click()
    await expect(page.getByRole('status')).toContainText(`Test alert sent to ${topic}`)
    await expect(page.locator('.alerts li', { hasText: 'Payung test alert' })).toContainText('Signed by you', { timeout: 30_000 })
    expect((await readAlerts(me, APP_NTFY)).find((a) => a.title === 'Payung test alert').signer).toBe(me)
    await expect(row).toContainText('Touched, paying out')
    const [, principalBefore, interestBefore] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [me] })
    await row.getByRole('button', { name: 'Pay out now' }).click()
    await expect(page.getByRole('status')).toContainText('into your loan', { timeout: 240_000 }) // a fork reads every slot over RPC
    await expect(row).toContainText('Paid', { timeout: 120_000 })
    const [, principalAfter, interestAfter] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [me] })
    const repaid = principalBefore + interestBefore - (principalAfter + interestAfter)
    expect(repaid > policy.cover - 10n ** 15n && repaid <= policy.cover).toBe(true) // the trove's debt fell by the cover

    // BTC recovers to ~10% above the touched strike. That strike stays closed for this expiry: the
    // app says so before anyone signs anything (the contract would revert "strike already touched").
    const recovered = Math.round(strikeUsd / 0.9)
    await setPrice(String(recovered))
    await page.getByRole('button', { name: 'Protect my loan' }).click()
    await expect(page.getByRole('img', { name: new RegExp(`BTC \\$${recovered.toLocaleString('en-US')}`) })).toBeVisible({ timeout: 60_000 })
    const current = await fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'currentExpiry' })
    const week = Number((policy.expiry - current) / 604800n) + 1
    await page.locator('.seg label', { hasText: week === 1 ? 'This week' : `${week} weeks` }).click()
    await page.getByRole('slider').fill(String(strikeUsd / 1000))
    await expect(page.getByText(`BTC already touched $${strikeUsd.toLocaleString('en-US')} in this cover period`)).toBeVisible()
    await expect(page.getByRole('button', { name: /Buy cover/ })).toBeDisabled()
  })
})
