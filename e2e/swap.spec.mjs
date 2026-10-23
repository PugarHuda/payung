// A wallet holding only BTC buys cover: the app swaps just enough BTC for the premium on Mezo
// Pools (the real router and BTC/MUSD pool), then buys from the real Payung vault. All on Mezo
// testnet: a fresh random wallet gets a little BTC from the e2e wallet and starts with 0 MUSD.
// (Not on an anvil fork: BTC's ERC-20 face is a Mezo precompile anvil can't run.)
//   E2E_KEY=0x... npx playwright test swap
import { test, expect } from '@playwright/test'
import { createPublicClient, createWalletClient, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { installWallet } from './wallet.mjs'
import { mezoTestnet, ADDR, mezoAbi, payungAbi, waitForReceipt } from '../shared/mezo.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY

test.describe('a BTC-only wallet on Mezo testnet', () => {
  test.skip(!KEY, 'set E2E_KEY (a wallet with testnet BTC to fund the fresh one)')

  test('swaps BTC for the premium on Mezo Pools, then buys cover', async ({ page }) => {
    test.setTimeout(420_000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const pub = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })
    // Nothing to buy when the vault is full: skip before spending testnet BTC on a fresh wallet.
    const vaultRoom = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'coverCapacity' })
    test.skip(vaultRoom < 10n * 10n ** 18n, `the vault can back only ${vaultRoom / 10n ** 18n} MUSD more right now`)
    const w = await installWallet(page, generatePrivateKey())
    const me = w.account.address
    const funder = createWalletClient({ account: privateKeyToAccount(KEY), chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })
    expect((await waitForReceipt(pub, await funder.sendTransaction({ to: me, value: parseEther('0.00002'), gas: 100_000n }))).status).toBe('success')
    const musdOf = () => pub.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [me] })
    expect(await musdOf()).toBe(0n)

    await page.goto('./')
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await expect(page.locator('.acct')).toContainText(me.slice(0, 6))
    // More than the vault can back: Buy is blocked anyway, so no swap is offered for it.
    await page.getByLabel('Cover amount (MUSD)').fill('1000000')
    await expect(page.getByText(/The vault can back|fully booked/)).toBeVisible()
    await expect(page.locator('.swap')).toHaveCount(0)
    // The farthest strike.
    await expect(page.getByRole('slider')).toBeEnabled()
    await page.getByRole('slider').focus()
    await page.keyboard.press('Home')
    const read = (functionName, args = []) => pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName, args })
    const [capacity, expiry] = await Promise.all([read('coverCapacity'), read('currentExpiry')])
    const strike = BigInt((await page.locator('.big').first().innerText()).match(/\$([\d,]+)/)[1].replace(/,/g, '')) * 10n ** 18n
    const open = (await read('strikeList', [expiry])).includes(strike)
    // Each run buys real cover from the shared vault: the 10 MUSD minimum on an open strike, 100 to open one.
    const cover = open ? 10n : 100n
    test.skip(capacity < cover * 10n ** 18n, `the vault can back only ${capacity / 10n ** 18n} MUSD more right now`)
    await page.getByLabel('Cover amount (MUSD)').fill(String(cover))
    await expect(page.getByText(/You have 0 MUSD/)).toBeVisible()
    // A real quote from the router, with the pool's rate against Mezo's oracle.
    await expect(page.locator('.swap')).toContainText(/swap 0\.\d+ BTC for [\d.]+ MUSD on Mezo Pools/)
    await expect(page.locator('.swap')).toContainText(/Pool rate \$[\d,]+ per BTC, [\d.]+% (under|over) Mezo's oracle/)
    await page.getByRole('button', { name: /^Swap 0\.\d+ BTC for MUSD$/ }).click()
    await expect(page.getByRole('status')).toContainText('Swapped BTC for about', { timeout: 240_000 })
    expect(await musdOf()).toBeGreaterThan(0n)

    // The premium is covered now: the swap box goes, and Buy goes through on the real vault.
    await expect(page.locator('.swap')).toHaveCount(0)
    const next = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policyCount' })
    await page.getByRole('button', { name: /^Buy cover for/ }).click()
    await expect(page.getByRole('status')).toContainText('Covered.', { timeout: 240_000 })
    await expect(page.getByRole('status')).toContainText('goes to your wallet') // no loan: no repay signature asked
    const ids = await pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'policiesOf', args: [me] })
    expect(ids.length).toBe(1)
    expect(ids[0]).toBeGreaterThanOrEqual(next)
    expect(w.state.requests).not.toContain('eth_signTypedData_v4')
    expect(errors).toEqual([])
  })
})
