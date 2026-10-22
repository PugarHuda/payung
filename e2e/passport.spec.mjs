// A Bitcoin wallet through Mezo Passport, against Mezo testnet: a real secp256k1 key in Node plays
// Unisat (BIP-137 signatures, native SegWit testnet address). It connects as the Mezo smart account
// OrangeKit predicts, reconnects on reload without a prompt, and a transaction attempt reports Mezo's
// relay refusing this site (OrangeKit sends Passport transactions only through
// test.mezo.org/api/v2/relay, which rejects other sites' pages), instead of a bare "Failed to fetch".
//   E2E_KEY=0x... npx playwright test passport
import { test, expect } from '@playwright/test'
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { btcKey, installUnisat } from './btcwallet.mjs'
import { mezoTestnet, ADDR, payungAbi, waitForReceipt } from '../shared/mezo.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY

test.describe('a Bitcoin wallet through Mezo Passport on Mezo testnet', () => {
  test.skip(!KEY, 'set E2E_KEY (a wallet with testnet BTC to fund the smart account)')

  test('connects as its smart account, says why the relay refused a transaction, reconnects on reload', async ({ page }) => {
    test.setTimeout(300_000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
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
    }
    await expect(page.getByText(/This is a smart-contract account/)).toBeVisible()
    await expect(page.getByLabel(/Repay my loan automatically/)).toBeDisabled()

    // The farthest strike (30% under BTC): its premium is cents, so the account's BTC covers the swap.
    await page.getByLabel('Cover amount (MUSD)').fill('100')
    await expect(page.getByRole('slider')).toBeEnabled()
    await page.getByRole('slider').focus()
    await page.keyboard.press('Home')
    await page.getByRole('button', { name: /^Swap 0\.\d+ BTC for MUSD$/ }).click({ timeout: 120_000 })
    await expect(page.getByRole('alert')).toContainText("Mezo's Passport relay didn't accept the transaction from this site", { timeout: 120_000 })
    expect(await pub.getCode({ address: safe })).toBeUndefined() // nothing was sent: the account is still undeployed
    expect((await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [safe] })).length).toBe(0)

    // Reload: the Bitcoin wallet is back, from getAccounts, with no new connect request.
    const prompts = log.filter((m) => m === 'requestAccounts').length
    await page.reload()
    await expect(page.locator('.acct')).toHaveAttribute('title', safe, { timeout: 60_000 })
    expect(log.filter((m) => m === 'requestAccounts').length).toBe(prompts)
    // Disconnect forgets it: no reconnect after the next reload.
    await page.getByRole('button', { name: 'Disconnect' }).click()
    await page.reload()
    await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible()
    await expect(page.locator('.acct')).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
