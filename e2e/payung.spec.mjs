import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { parseUnits } from 'viem'
import { installWallet } from './wallet.mjs'
import { ADDR, mezoAbi, repayTypedData, repayHints, waitForReceipt, GAS } from '../shared/mezo.js'

const KEY = process.env.E2E_KEY ?? process.env.PRIVATE_KEY

test.describe('without a wallet', () => {
  test('reads the live vault and explains how to connect', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('./')
    await expect(page.getByRole('heading', { name: /Open an umbrella/ })).toBeVisible()
    await expect(page.getByRole('img', { name: /BTC \$[\d,]+, strike \$[\d,]+/ })).toBeVisible() // price shaft from Mezo's feed
    await expect(page.getByText(/Premium for the whole period/)).toBeVisible()
    await expect(page.locator('.quote strong')).toHaveText(/[\d.]+ MUSD/) // quote came from the contract
    await expect(page.getByText(/volatility measured on-chain .*\d+% a year/)).toBeVisible()

    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText(/No browser wallet found/)

    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    await expect(page.locator('.facts div', { hasText: 'Vault value' })).toContainText('MUSD')
    await expect(page.locator('.activity')).toContainText('Cover bought') // decoded from the explorer's log API
    await expect(page.getByText(/capped at 50% of the vault/)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('./')
    await expect(page.getByRole('img', { name: /BTC/ })).toBeVisible()
    for (const tab of ['Protect my loan', 'Earn by underwriting', 'My cover']) {
      await page.getByRole('button', { name: tab }).click()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${tab} overflows`).toBeLessThanOrEqual(0)
    }
  })

  test('has no WCAG A/AA violations on any tab (axe-core)', async ({ page }) => {
    await page.goto('./')
    await expect(page.locator('.quote strong')).toHaveText(/MUSD/)
    for (const tab of ['Protect my loan', 'Earn by underwriting', 'My cover']) {
      await page.getByRole('button', { name: tab }).click()
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      expect(violations.map((v) => `${tab}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([])
    }
  })

  test('tabs work from the keyboard with a visible focus ring', async ({ page }) => {
    await page.goto('./')
    const tab = page.getByRole('button', { name: 'Earn by underwriting' })
    await tab.focus()
    await page.keyboard.press('Enter')
    await expect(tab).toHaveAttribute('aria-current', 'page')
    const outline = await tab.evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(outline).not.toBe('none')
  })
})

test.describe('with a wallet on Mezo testnet', () => {
  test.skip(!KEY, 'set E2E_KEY (a funded Mezo testnet key with a trove and MUSD)')

  test('connects, switches network, validates input, buys cover, re-arms auto-repay, underwrites', async ({ page, context }) => {
    test.setTimeout(600_000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await context.grantPermissions(['notifications'])
    const w = await installWallet(page, KEY)
    await page.goto('./')

    // Connect: wallet starts on Ethereum mainnet without Mezo; the app adds and switches to Mezo.
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await expect(page.locator('.acct')).toHaveText(new RegExp(w.account.address.slice(0, 6)))
    expect(w.state.requests).toContain('wallet_addEthereumChain')
    expect(w.state.chainId).toBe(31611)
    await expect(page.locator('.facts div', { hasText: 'Your loan' })).toContainText('MUSD')
    await expect(page.locator('.facts div', { hasText: 'Liquidation at' })).toContainText('$')

    // Wrong network mid-session blocks writes until switched back.
    await page.evaluate(() => window.__emitWallet('chainChanged', '0x1'))
    await expect(page.getByText('Your wallet is on another network.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Buy cover/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Switch to Mezo testnet' }).click()
    await expect(page.getByText('Your wallet is on another network.')).toBeHidden()

    // Input validation.
    const cover = page.getByLabel('Cover amount (MUSD)')
    const buy = page.getByRole('button', { name: /^Buy cover/ })
    await cover.fill('abc')
    await expect(cover).toHaveValue('') // letters are stripped
    await cover.fill('1.2.3')
    await expect(page.getByText('Enter a number, like 500.')).toBeVisible()
    await expect(buy).toBeDisabled()
    await cover.fill('5')
    await expect(page.getByText('The smallest cover is 10 MUSD.')).toBeVisible()
    await expect(buy).toBeDisabled()
    await cover.fill('99999999')
    await expect(page.getByText(/The vault can back .* more this week/)).toBeVisible()
    await expect(buy).toBeDisabled()

    // Strike slider stays inside the 5-30% band the contract accepts.
    const slider = page.getByRole('slider')
    await slider.focus()
    await page.keyboard.press('End')
    await expect(page.locator('.big small')).toHaveText(/(5|6)\.\d% below now/)
    await page.keyboard.press('Home')
    await expect(page.locator('.big small')).toHaveText(/(2[89]|30)\.\d% below now/) // ceil(70% of spot) to the $1,000 grid
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')

    // Underwrite first: withdraw 20 MUSD of free liquidity (funds the wallet for the run), then
    // deposit 10 back, which also adds backing capacity for the cover bought next.
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    const amountBox = page.getByLabel('Amount (MUSD)')
    await amountBox.fill('20')
    await page.getByRole('button', { name: 'Withdraw' }).click()
    await expect(page.getByRole('status')).toContainText('Withdrew 20 MUSD.', { timeout: 180_000 })
    await amountBox.fill('10')
    await page.getByRole('button', { name: 'Deposit' }).click()
    await expect(page.getByRole('status')).toContainText('Deposited 10 MUSD.', { timeout: 180_000 })
    await page.getByRole('button', { name: 'Protect my loan' }).click()
    await cover.fill('25')
    // A strike under the liquidation line: the app warns that Mezo would refuse the repay.
    await slider.focus()
    await page.keyboard.press('Home')
    await expect(page.getByText(/Mezo would refuse the repay/)).toBeVisible()
    // ~8-9% below spot, above this loan's liquidation line: the warning clears.
    await page.keyboard.press('End')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
    await expect(page.getByText(/Mezo would refuse the repay/)).toBeHidden()

    // Cover period: a longer term moves the expiry and costs more (more time for a touch).
    await cover.fill('25')
    // Compare the rate (% of cover): it doesn't depend on which cover amount the last quote used.
    const rateOf = async () => Number(((await page.locator('.quote small').textContent()) ?? '').replace(/[^0-9.]/g, ''))
    // Quotes arrive async after every strike/amount change: wait until the shown rate stops moving.
    const settled = async () => {
      const a = await rateOf()
      await page.waitForTimeout(2000)
      return a > 0 && a === (await rateOf()) ? a : -1
    }
    await expect.poll(settled, { timeout: 60_000 }).toBeGreaterThan(0)
    const oneWeek = await rateOf()
    await page.getByText('3 weeks').click()
    await expect.poll(rateOf).toBeGreaterThan(oneWeek)
    await page.getByText('2 weeks').click()

    // Buy real 2-week cover with auto-repay, sized to what the vault can still back.
    await expect(page.getByRole('checkbox')).toBeChecked()
    await expect(buy).toBeEnabled()
    await buy.click()
    await expect(page.getByRole('status')).toContainText('Covered.', { timeout: 120_000 })
    await expect(page.getByRole('status').getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', /explorer\.test\.mezo\.org\/tx\/0x/)

    // My cover: the new policy is active and Mezo's repay dry-run passes.
    await page.getByRole('button', { name: 'My cover' }).click()
    const row = page.locator('tbody tr').first()
    await expect(row).toContainText('25 MUSD')
    await expect(row).toContainText('Active')
    await expect(row).toContainText('Loan, repay checked', { timeout: 120_000 })
    await expect(page.getByText(/Browser alerts are on/)).toBeVisible()

    // Another Mezo signature action (a signed 1 MUSD repay) uses up the nonce: the app spots it and re-signs.
    const nonce = await w.pub.readContract({ address: ADDR.sigs, abi: mezoAbi, functionName: 'getNonce', args: [w.account.address] })
    const amount = parseUnits('1', 18)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const sig = await w.account.signTypedData(repayTypedData({ amount, borrower: w.account.address, nonce, deadline }))
    const [upper, lower] = await repayHints(w.pub, w.account.address, amount)
    const hash = await w.wallet.writeContract({ address: ADDR.sigs, abi: mezoAbi, functionName: 'repayMUSDWithSignature', args: [amount, upper, lower, w.account.address, sig, deadline], gas: GAS })
    expect((await waitForReceipt(w.pub, hash)).status).toBe('success')
    await page.reload()
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await page.getByRole('button', { name: 'My cover' }).click()
    await expect(row).toContainText('repay signature no longer valid')
    await row.getByRole('button', { name: 'Re-sign' }).click()
    await expect(page.getByRole('status')).toContainText('Auto-repay re-signed', { timeout: 240_000 })
    await expect(row).toContainText('Loan, repay checked')

    // Underwrite: withdraw 10 MUSD of free liquidity.
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    await amountBox.fill('10')
    await page.getByRole('button', { name: 'Withdraw' }).click()
    await expect(page.getByRole('status')).toContainText('Withdrew 10 MUSD.', { timeout: 120_000 })
    await amountBox.fill('100000000')
    await expect(page.getByText(/Your wallet holds/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Deposit' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Withdraw' })).toBeDisabled()

    // Switching accounts in the wallet resets what the app shows.
    await page.evaluate(() => window.__emitWallet('accountsChanged', ['0x000000000000000000000000000000000000dEaD']))
    await expect(page.locator('.acct')).toHaveText('0x0000…dEaD')
    expect(errors).toEqual([])
  })
})
