// Records the demo video: the live app (production by default) walked through scene by scene, with
// a caption per scene, following the 2-minute script in SUBMISSION.md. Everything on screen is
// real: Mezo testnet data read live, viewed through ?address= (read-only) for the team's wallet,
// which has a Mezo loan, cover in both vaults and phone alerts.
// The seconds before the first scene (the page reading Mezo) are cut, and the result is encoded as
// H.264 MP4 with ffmpeg when it is installed (else the raw WebM is kept).
//   node scripts/record-demo.mjs [app url]    -> demo/payung-demo.mp4 (or .webm)
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'

const APP = process.argv[2] ?? 'https://payung-ecru.vercel.app/'
const WALLET = '0xe42F6c4b72577CE2A64D583CF2f33a2D729c9C81'
const SIZE = { width: 1280, height: 720 }
mkdirSync('demo', { recursive: true })

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge' }) // Edge ships with Windows, as in playwright.config.mjs
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: 'demo/raw', size: SIZE } })
const page = await context.newPage()
const t0 = Date.now() // the recording starts with the page
let start = 0 // seconds into the recording when the first scene is ready
const pause = (ms) => page.waitForTimeout(ms)

// A caption bar over the page, set through the DOM (allowed under the app's CSP).
async function caption(text) {
  await page.evaluate((t) => {
    let bar = document.getElementById('demo-caption')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'demo-caption'
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 28px;background:rgba(19,32,43,0.92);color:#f6f3ec;font:600 20px/1.35 system-ui,sans-serif;text-align:center'
      document.body.appendChild(bar)
    }
    bar.textContent = t
  }, text)
}
const tab = (name) => page.getByRole('button', { name, exact: true }).click()

await page.goto(`${APP}?address=${WALLET}`)
await page.getByRole('img', { name: /^BTC \$/ }).waitFor({ timeout: 60_000 })
await page.locator('.facts div', { hasText: 'Redemption queue' }).waitFor({ timeout: 60_000 })
start = (Date.now() - t0) / 1000
await caption('Mezo lets you borrow MUSD against Bitcoin without selling it. If BTC falls far enough, the loan is liquidated and the Bitcoin is gone.')
await pause(7000)

await caption('Payung reads the loan live from Mezo: collateral ratio, the real liquidation line (recovery mode included) and its place in the redemption queue.')
await page.locator('.facts').scrollIntoViewIfNeeded()
await pause(7000)

await caption('Pick a strike just above the liquidation line. The premium comes from BTC volatility the contract measures itself on Mezo’s price feed.')
const slider = page.getByRole('slider')
await slider.focus()
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('ArrowLeft')
  await pause(500)
}
await page.locator('.quote').scrollIntoViewIfNeeded()
await pause(4000)
await page.getByText('2 weeks', { exact: true }).click()
await pause(3000)

await caption('Odds are shown two ways: the on-chain volatility model, and a backtest over 30 days of Mezo’s own oracle history.')
await page.locator('.odds').scrollIntoViewIfNeeded()
await pause(7000)

await caption('If BTC touches the strike, anyone can trigger it and earn 0.1%. The cover is paid straight into the loan through Mezo’s repayMUSDWithSignature.')
await page.evaluate(() => window.scrollTo(0, 0))
await pause(6000)

await tab('Earn by underwriting')
await page.locator('.facts div', { hasText: 'Vault value' }).waitFor({ timeout: 60_000 })
await caption('MUSD holders fund the cover in an ERC-4626 vault and earn the premiums. Every policy is fully backed; at most half the vault is at risk.')
await pause(7000)
await page.locator('.activity').scrollIntoViewIfNeeded().catch(() => {})
await caption('Every vault event since launch, read from Mezo’s explorer, and a stress test of what each BTC drop would pay out.')
await pause(6000)

await tab('My cover')
await page.locator('main.policies tbody tr').first().waitFor({ timeout: 60_000 })
await caption('My cover: each policy, a live dry-run of the repay into the loan, renewal links and calendar reminders.')
await pause(7000)
await page.locator('.phone').scrollIntoViewIfNeeded().catch(() => {})
await caption('Signed phone alerts through ntfy, even with the page closed. Bitcoin wallets sign theirs with BIP-137 through Mezo Passport.')
await pause(7000)

await page.evaluate(() => window.scrollTo(0, 0))
await caption('Live on Mezo testnet, Sourcify-verified, watched by a keeper. Payung: keep your Bitcoin dry.')
await pause(6000)

const video = page.video()
await context.close()
await browser.close()
const raw = await video.path()
let out = 'demo/payung-demo.mp4'
try {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', start.toFixed(2), '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out])
} catch {
  out = 'demo/payung-demo.webm' // no ffmpeg: keep the recording as it is
  rmSync(out, { force: true })
  renameSync(raw, out)
}
rmSync('demo/raw', { recursive: true, force: true })
console.log(out, `(first ${start.toFixed(1)} s of loading cut)`)
