import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { parseUnits } from 'viem'
import { installWallet } from './wallet.mjs'
import { ADDR, mezoAbi, payungAbi, repayTypedData, repayHints, waitForReceipt, GAS } from '../shared/mezo.js'

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
    // Every event since deployment, newest first, without the 15-minute volatility samples.
    await expect(page.locator('.activity li').first()).toContainText(/ago|just now/)
    await expect(page.locator('.activity')).not.toContainText('Volatility sample')
    await expect(page.getByText(/capped at 50% of the vault/)).toBeVisible()
    // Archive reads of the share price since deployment: 25 samples, starting at 1 MUSD.
    // Stress test from the vault's strike book: running totals, each row at least the one above.
    const totals = await page.locator('table.exposure tbody td:nth-child(4)').allInnerTexts()
    const nums = totals.map((t) => Number(t.replace(/[^\d.]/g, '')))
    expect(nums.length).toBeGreaterThan(0)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
    // Expected payout is a positive amount, and below the worst case (every strike touched).
    const expected = Number((await page.locator('.expected strong').first().innerText()).replace(/[^\d.]/g, ''))
    expect(expected).toBeGreaterThan(0)
    expect(expected).toBeLessThan(nums.at(-1))
    // Older events page in from the whole history.
    const shown = await page.locator('.activity li').count()
    await page.getByRole('button', { name: /Show older/ }).click()
    expect(await page.locator('.activity li').count()).toBeGreaterThan(shown)
    await expect(page.locator('.history figcaption')).toContainText(/1 pyMUSD: 1\.0000 → \d\.\d{4} MUSD since launch.*at 25 past blocks/)
    expect(errors).toEqual([])
  })

  test('a renewal link prefills strike, cover and period, and ignores junk', async ({ page }) => {
    // The next-but-one weekly expiry (Thursday 00:00 UTC), as a calendar reminder would carry it.
    const week = 604800
    const next = Math.ceil(Date.now() / 1000 / week) * week + week
    await page.goto(`./?strike=1000&cover=42&expiry=${next}`)
    await expect(page.getByText(/Your previous strike, \$1,000, is outside today's range/)).toBeVisible()
    await expect(page.getByLabel('Cover amount (MUSD)')).toHaveValue('42')
    await expect(page.locator('.seg label.on')).toHaveText('2 weeks')
    await page.goto('./?strike=abc&cover=1e9&expiry=-1')
    await expect(page.locator('.quote strong')).toHaveText(/MUSD/)
    await expect(page.locator('.seg label.on')).toHaveText('This week')
    await expect(page.getByLabel('Cover amount (MUSD)')).not.toHaveValue('1e9')
    await expect(page.locator('em.hint')).toHaveCount(0)
  })

  test('touch odds: on-chain-vol model and a backtest over 30 days of Mezo oracle history', async ({ page }) => {
    await page.goto('./')
    const caption = page.locator('.odds figcaption')
    const chance = async () => {
      const m = (await caption.innerText()).match(/about (under 0\.1|[\d.]+)%/)
      return m[1] === 'under 0.1' ? 0 : Number(m[1])
    }
    await expect(caption).toContainText(/Over the last 30 days on Mezo's oracle, BTC fell [\d.]+% or more within .* in \d+ of \d+ overlapping stretches/, { timeout: 60_000 })
    await expect(caption).toContainText(/30-day low: \$[\d,]+ on /)
    await expect(page.getByRole('img', { name: /BTC over 30 days on Mezo's oracle, low \$[\d,]+/ })).toBeVisible()
    // ~360 archive points drawn
    expect((await page.locator('.odds polyline').getAttribute('points')).split(' ').length).toBeGreaterThan(300)
    const oneWeek = await chance()
    await page.locator('.seg label', { hasText: '4 weeks' }).click()
    await expect(caption).toContainText('only 1 separate stretch') // 30 days hold one 3-4 week stretch
    expect(await chance()).toBeGreaterThan(oneWeek) // longer cover, likelier touch
    // A nearer strike is likelier to be touched.
    await page.getByRole('slider').focus()
    const far = await chance()
    await page.keyboard.press('End')
    await expect.poll(chance).toBeGreaterThan(far)
  })

  test('runs under a strict CSP with no violations and refuses to be framed', async ({ page, baseURL }) => {
    // A page that asks for wallet signatures must not be framable (clickjacking).
    const res = await page.goto('./')
    const h = res.headers()
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(h['content-security-policy']).toContain("script-src 'self';")
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    // Every tab loads its live data (RPC, explorer, fonts) without tripping the policy.
    const violations = []
    page.on('console', (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()))
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`Content Security Policy: ${e.violatedDirective} ${e.blockedURI}`)))
    await page.reload()
    await expect(page.locator('.quote strong')).toHaveText(/MUSD/)
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    await expect(page.locator('.activity')).toContainText('Cover bought')
    await expect(page.locator('.history figcaption')).toBeVisible()
    await page.getByRole('button', { name: 'My cover' }).click()
    expect(violations).toEqual([])
    // Framed by another page: the browser refuses to render it.
    await page.goto('about:blank')
    await page.setContent(`<iframe src="${baseURL}" width="800" height="600"></iframe>`)
    await page.waitForTimeout(3000)
    // Each engine shows a blocked frame its own way (Chromium: chrome-error:, Firefox: no URL, WebKit:
    // the URL with an empty document); in none may the app render.
    const frame = page.frames().find((f) => f !== page.mainFrame())
    // (Firefox never answers inside its blocked frame, hence the time limit.)
    const framed = await Promise.race([frame.evaluate(() => document.body?.innerText ?? '').catch(() => ''), new Promise((r) => setTimeout(() => r(''), 5000))])
    expect(framed).not.toContain('Open an umbrella')
    if (frame.url().startsWith(baseURL)) expect(framed.trim()).toBe('') // WebKit: the URL, but nothing rendered
  })

  test('says so when Mezo RPC or explorer is down, and recovers', async ({ page }) => {
    // RPC down: a banner, and no made-up numbers (the share price stays unknown).
    await page.route(/rpc\.test\.mezo\.org/, (r) => r.abort())
    await page.goto('./')
    await expect(page.getByRole('alert')).toContainText("Can't reach Mezo's RPC", { timeout: 40_000 })
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    await expect(page.locator('.facts div', { hasText: '1 pyMUSD' }).locator('dd')).toHaveText('…')
    // Back up: the next refresh clears the banner.
    await page.unroute(/rpc\.test\.mezo\.org/)
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 40_000 })
    await expect(page.locator('.facts div', { hasText: '1 pyMUSD' }).locator('dd')).toHaveText(/^\d\.\d{4} MUSD$/)

    // Explorer down: premiums say why they're missing instead of loading forever.
    await page.route(/api\.explorer\.test\.mezo\.org/, (r) => r.abort())
    await page.reload()
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    await expect(page.locator('.facts div', { hasText: 'Premiums on open cover' }).locator('dd')).toHaveText('explorer offline', { timeout: 30_000 })
  })

  test('?address= shows a real wallet\'s loan, cover and alerts read-only', async ({ page }) => {
    const holder = '0xe42F6c4b72577CE2A64D583CF2f33a2D729c9C81' // the e2e wallet: a Mezo loan and real policies
    await page.goto(`./?address=${holder}`)
    await expect(page.getByRole('status').first()).toContainText('Viewing 0xe42F…9C81 read-only')
    await expect(page.locator('.facts div', { hasText: 'Your loan' }).locator('dd')).toHaveText(/MUSD/)
    await expect(page.getByRole('button', { name: 'Connect wallet to buy cover' })).toBeVisible()
    await page.getByRole('button', { name: 'My cover' }).click()
    const rows = page.locator('main.policies tbody tr')
    await expect(rows.first()).toBeVisible()
    for (const pill of await page.locator('main.policies tbody .pill').allInnerTexts()) expect(['Active', 'Paid', 'Expired', 'Touched, paying out']).toContain(pill)
    // Nothing can be signed or sent from a view.
    for (const b of await page.getByRole('button', { name: /Pay out now|Re-sign|Send a test alert/ }).all()) await expect(b).toBeDisabled()
    await expect(page.locator('.phone code')).toHaveText(`payung-${holder.toLowerCase().slice(2)}`)
    const ics = page.locator('a[download$=".ics"]').first()
    if (await ics.count()) expect(decodeURIComponent(await ics.getAttribute('href'))).toMatch(/BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z[\s\S]*END:VCALENDAR/)
    // Junk in the parameter is ignored: no view, the normal connect button.
    await page.goto('./?address=0x123')
    await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible()
    await expect(page.getByText('read-only')).toHaveCount(0)
  })

  test('a cover amount typed before the vault loads is kept', async ({ page }) => {
    let release
    const gate = new Promise((r) => (release = r))
    await page.route(/rpc\.test\.mezo\.org/, async (r) => (await gate, r.continue()))
    await page.goto('./')
    await page.getByLabel('Cover amount (MUSD)').fill('40')
    release()
    await expect(page.locator('.gauge-col svg')).toBeVisible({ timeout: 40_000 })
    await expect(page.locator('.quote strong')).toHaveText(/MUSD/, { timeout: 30_000 })
    await expect(page.getByLabel('Cover amount (MUSD)')).toHaveValue('40')
  })

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('./')
    await expect(page.getByRole('img', { name: /^BTC \$/ })).toBeVisible()
    for (const tab of ['Protect my loan', 'Earn by underwriting', 'My cover']) {
      await page.getByRole('button', { name: tab }).click()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${tab} overflows`).toBeLessThanOrEqual(0)
    }
    // Installable on the home screen: the linked manifest loads and its icon is served.
    const href = await page.locator('link[rel=manifest]').getAttribute('href')
    const manifest = await (await page.request.get(new URL(href, page.url()).href)).json()
    expect(manifest).toMatchObject({ short_name: 'Payung', display: 'standalone' })
    expect((await page.request.get(new URL(manifest.icons[0].src, page.url()).href)).ok()).toBe(true)
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
    await expect(page.locator('.facts div', { hasText: 'BTC now' })).toContainText(/\$[\d,]+ \((\d+ min ago|just now)\)/) // oracle's updatedAt
    await expect(page.locator('.facts div', { hasText: 'Collateral ratio' })).toContainText(/\d+% \(BTC \d+% above liquidation\)/)

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
    await expect(page.getByText(/The vault can back .* more right now|cover is fully booked/)).toBeVisible() // which one depends on what earlier runs locked
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
    // deposit back, which also adds backing capacity for the cover bought next. Every run locks
    // another 10 MUSD for two weeks, so deposit enough that 15 MUSD of capacity is free (50% of a deposit).
    await page.getByRole('button', { name: 'Earn by underwriting' }).click()
    const amountBox = page.getByLabel('Amount (MUSD)')
    // Read capacity now, while the chain is settled: right after a transaction a lagging RPC node
    // can still answer with the old value. Withdrawing 20 MUSD takes 10 off it.
    // coverCapacity() stops at 0; rebuild it unclamped, as the contract does: (balance - owed) x cap - locked.
    const p = (functionName) => w.pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName })
    const [vaultBal, owed, maxUtil, locked] = await Promise.all([w.pub.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [ADDR.payung] }), p('totalOwed'), p('maxUtilization'), p('totalLocked')])
    const capacity = (Number(vaultBal - owed) * Number(maxUtil)) / 1e4 / 1e18 - Number(locked) / 1e18 - 10
    const wallet = Number(await w.pub.readContract({ address: ADDR.musd, abi: mezoAbi, functionName: 'balanceOf', args: [w.account.address] })) / 1e18 + 20
    const needed = Math.max(10, Math.ceil(((15 - capacity) * 2) / 10) * 10)
    // The live vault is shared and its cover locks until expiry: say so plainly rather than wait on a disabled button.
    expect(needed, `the vault needs a ${needed} MUSD deposit for this run's cover and the test wallet holds ${wallet.toFixed(2)}; fund it or wait for an expiry to free capacity`).toBeLessThanOrEqual(wallet)
    await amountBox.fill('20')
    await page.getByRole('button', { name: 'Withdraw' }).click()
    await expect(page.getByRole('status')).toContainText('Withdrew 20 MUSD.', { timeout: 180_000 })
    const topUp = needed
    await amountBox.fill(String(topUp))
    await page.getByRole('button', { name: 'Deposit' }).click()
    await expect(page.getByRole('status')).toContainText(`Deposited ${topUp} MUSD.`, { timeout: 180_000 })
    // Mezo's load-balanced RPC can lag a block: wait until the deposit shows as capacity.
    await expect.poll(async () => Number(await w.pub.readContract({ address: ADDR.payung, abi: payungAbi, functionName: 'coverCapacity' })) / 1e18, { timeout: 60_000 }).toBeGreaterThanOrEqual(10)
    // Earnings come from this wallet's Deposit/Withdraw events since the vault launched.
    await expect(page.getByText(/Earned so far: [+−][\d.,]+ MUSD on [\d,]+ MUSD deposited/)).toBeVisible({ timeout: 60_000 })
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
    await cover.fill('10')
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
    await expect(row).toContainText('10 MUSD')
    await expect(row).toContainText('Active')
    await expect(row).toContainText('Loan, repay checked', { timeout: 120_000 })
    await expect(page.getByText(/Browser alerts are on/)).toBeVisible()
    // Expiry reminder: an RFC 5545 event at the policy's expiry with an alarm a day before.
    const ics = decodeURIComponent((await row.getByRole('link', { name: 'Add to calendar' }).getAttribute('href')).split(',').slice(1).join(','))
    expect(ics).toMatch(/BEGIN:VEVENT\r\n.*DTSTART:\d{8}T000000Z\r\n/s) // Thursday 00:00 UTC
    expect(ics).toContain('TRIGGER:-P1D')
    expect(ics).toMatch(/SUMMARY:Payung cover ends \(\$\d+\\,\d{3} strike\\, 10 MUSD\)/) // commas escaped per RFC 5545
    expect(ics.split('\r\n').every((l) => l.length <= 75)).toBe(true) // long lines folded
    const renewUrl = ics.replace(/\r\n /g, '').match(/Renew it for the next week: (\S+)/)[1]
    expect(renewUrl).toMatch(/\?strike=\d+&cover=10&expiry=\d+$/)
    // Renew: back on Protect with the same strike and cover, the week after this cover ends (week 3).
    const strikeText = (await row.locator('td').first().innerText()).trim()
    await row.getByRole('button', { name: 'Renew for the next week' }).click()
    await expect(page.locator('.big').first()).toContainText(strikeText)
    await expect(page.getByLabel('Cover amount (MUSD)')).toHaveValue('10')
    await expect(page.locator('.seg label.on')).toHaveText('3 weeks')
    await page.getByRole('button', { name: 'My cover' }).click()

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
