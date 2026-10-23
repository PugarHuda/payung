// A Bitcoin wallet uses Payung through Mezo Passport, for real, on Mezo testnet. A secp256k1 key
// in Node plays Unisat (BIP-137 signatures, native SegWit testnet address). Its Mezo smart account
// (an OrangeKit Safe) is deployed and driven through Payung's relayer (api/relay.js, served locally
// by the Playwright config): it swaps BTC for the premium on Mezo Pools and buys cover from the real
// vault, every transaction signed by the Bitcoin key and checked by the Safe on-chain.
//   E2E_KEY=0x... RELAYER_KEY=0x... npx playwright test passport
import { test, expect } from '@playwright/test'
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { btcKey, installUnisat } from './btcwallet.mjs'
import { mezoTestnet, ADDR, payungAbi, waitForReceipt } from '../shared/mezo.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY

test.describe('a Bitcoin wallet through Mezo Passport on Mezo testnet', () => {
  test.skip(!KEY || !process.env.RELAYER_KEY, 'set E2E_KEY (funds the smart account) and RELAYER_KEY (submits its transactions)')

  test('its smart account swaps on Mezo Pools and buys cover through Payung\'s relayer, signed in Bitcoin; reconnects on reload', async ({ page }) => {
    test.setTimeout(600_000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => m.type() === 'warning' && /failed/.test(m.text()) && console.log('PAGE', m.text().slice(0, 800)))
    // The same Bitcoin key (so the same smart account) every run: testnet BTC sent to it isn't lost.
    const key = btcKey(keccak256(toHex(`${KEY}:payung-passport-e2e`)).slice(2))
    const log = await installUnisat(page, key)
    const pub = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })

    await page.goto('./')
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await page.getByRole('button', { name: /Unisat via Mezo Passport/ }).click()
    await expect(page.locator('.acct')).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/, { timeout: 60_000 })
    const safe = await page.locator('.acct').getAttribute('title')
    if ((await pub.getBalance({ address: safe })) < parseEther('0.00001')) {
      const funder = createWalletClient({ account: privateKeyToAccount(KEY), chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })
      expect((await waitForReceipt(pub, await funder.sendTransaction({ to: safe, value: parseEther('0.00002'), gas: 100_000n }))).status).toBe('success')
      await page.reload()
      await expect(page.locator('.acct')).toHaveAttribute('title', safe, { timeout: 60_000 })
    }
    const before = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [safe] })
    await expect(page.getByText(/This is a smart-contract account/)).toBeVisible()
    await expect(page.getByLabel(/Repay my loan automatically/)).toBeDisabled()

    // Phone alerts: a test alert signed by the Bitcoin key (BIP-137), read back from ntfy.sh and
    // traced through OrangeKit's factory to this very account.
    await page.getByRole('button', { name: 'My cover' }).click()
    await page.getByRole('button', { name: 'Send a test alert' }).click()
    await expect(page.getByRole('status')).toContainText('signed by your Bitcoin wallet', { timeout: 60_000 })
    await expect(page.locator('.alerts li', { hasText: 'Payung test alert' }).first()).toContainText('Signed by you', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Protect my loan' }).click()

    // The farthest strike (30% under BTC): its premium is cents, so a little BTC pays it.
    await page.getByLabel('Cover amount (MUSD)').fill('100')
    await expect(page.getByRole('slider')).toBeEnabled()
    await page.getByRole('slider').focus()
    await page.keyboard.press('Home')
    // Size the cover to what the vault can still back: a strike already open this period takes any
    // cover from 10 MUSD, a new one needs 100.
    const read = (functionName, args = []) => pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName, args })
    const [capacity, expiry] = await Promise.all([read('coverCapacity'), read('currentExpiry')])
    const strike = BigInt((await page.locator('.big').first().innerText()).match(/\$([\d,]+)/)[1].replace(/,/g, '')) * 10n ** 18n
    const open = (await read('strikeList', [expiry])).includes(strike)
    const cover = capacity >= 100n * 10n ** 18n ? 100n : open ? capacity / 10n ** 18n : 0n
    test.skip(cover < 10n, `the vault can back only ${capacity / 10n ** 18n} MUSD more right now`)
    await page.getByLabel('Cover amount (MUSD)').fill(String(cover))
    const signed = () => log.filter((m) => m === 'signMessage').length
    await expect(page.locator('.quote strong')).toHaveText(/MUSD/, { timeout: 60_000 })
    await expect(page.getByRole('button', { name: /^Buy cover for [\d.]+ MUSD$/ })).toBeVisible() // the quote is in
    // MUSD left from an earlier run may already pay the premium; otherwise the app offers the swap.
    if (await page.getByText(/Borrow or buy MUSD on Mezo to pay the premium/).isVisible()) {
      await page.getByRole('button', { name: /^Swap 0\.\d+ BTC for MUSD$/ }).click({ timeout: 60_000 })
      await expect(page.getByRole('status')).toContainText('Swapped BTC for about', { timeout: 300_000 })
      expect(signed()).toBeGreaterThanOrEqual(1) // the swap (and the BTC approval) signed in Bitcoin
    }
    expect((await pub.getCode({ address: safe }))?.length).toBeGreaterThan(2) // deployed through the relayer on first use

    // Cancel in the Bitcoin wallet: plain words, and nothing reaches the chain.
    const policiesNow = (await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [safe] })).length
    log.reject = true
    await page.getByRole('button', { name: /^Buy cover for/ }).click()
    await expect(page.getByRole('alert')).toHaveText('You cancelled the request in your wallet.', { timeout: 120_000 })
    expect((await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [safe] })).length).toBe(policiesNow)
    log.reject = false

    const beforeBuy = signed()
    await page.getByRole('button', { name: /^Buy cover for/ }).click()
    await expect(page.getByRole('status')).toContainText('Covered.', { timeout: 300_000 })
    await expect(page.getByRole('status')).toContainText('goes to your wallet') // a smart account can't pre-sign Mezo's repay
    expect(signed()).toBeGreaterThan(beforeBuy)
    const ids = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [safe] })
    expect(ids.length).toBe(before.length + 1)
    const p = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policy', args: [ids.at(-1)] })
    expect(p.holder).toBe(safe)
    expect(p.autoRepay).toBe(false)

    // Reload: the Bitcoin wallet is back, from getAccounts, with no new connect request; Disconnect sticks.
    const prompts = log.filter((m) => m === 'requestAccounts').length
    await page.reload()
    await expect(page.locator('.acct')).toHaveAttribute('title', safe, { timeout: 60_000 })
    expect(log.filter((m) => m === 'requestAccounts').length).toBe(prompts)
    await page.getByRole('button', { name: 'Disconnect' }).click()
    await page.reload()
    await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible()
    expect(errors).toEqual([])
  })
})
