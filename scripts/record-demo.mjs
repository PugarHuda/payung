// Records the demo video: the live app (production by default) walked through scene by scene, each
// scene with a caption that is also spoken, following the 2-minute script in SUBMISSION.md.
// Everything on screen is real: Mezo testnet data read live, viewed through ?address= (read-only)
// for the team's wallet (after the landing page), which has a Mezo loan, cover in both vaults and phone alerts.
// Narration uses Windows' built-in speech synthesizer (System.Speech: offline, no key); each scene
// lasts as long as its line. ffmpeg cuts the seconds of loading (before the first scene, and while a
// scene marked cut loads a page) and muxes the voice into an H.264/AAC MP4. Without PowerShell or ffmpeg it falls back to a silent WebM.
//   node scripts/record-demo.mjs [app url]    -> demo/payung-demo.mp4
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const APP = process.argv[2] ?? 'https://payung-ecru.vercel.app/'
const WALLET = '0xe42F6c4b72577CE2A64D583CF2f33a2D729c9C81'
const SIZE = { width: 1280, height: 720 }
const VOICE = process.env.DEMO_VOICE ?? 'Microsoft Zira Desktop'
mkdirSync('demo/voice', { recursive: true })

// Each scene: what happens on screen, then the line shown and spoken while it is on screen.
const scenes = [
  { say: 'Mezo lets you borrow MUSD against your Bitcoin without selling it. But if Bitcoin falls far enough, the loan is liquidated, and the Bitcoin is gone.' },
  { say: 'Payung sells cover against that fall. Borrowers buy it, MUSD holders underwrite it, and the numbers are live from Mezo.', act: (p) => p.locator('.stats').evaluate((e) => e.scrollIntoView({ block: 'center' })) },
  {
    say: 'Payung reads the loan live from Mezo: its collateral ratio, the real liquidation line, recovery mode included, and its place in the redemption queue.',
    cut: true, // the seconds this page takes to load are cut from the video
    act: async (p) => {
      await p.goto(`${APP}?address=${WALLET}`)
      await p.getByRole('img', { name: /^BTC \$/ }).waitFor({ timeout: 60_000 })
      await p.locator('.facts div', { hasText: 'Redemption queue' }).waitFor({ timeout: 60_000 })
      await p.waitForTimeout(800)
    },
  },
  {
    say: 'You pick a strike just above the liquidation line. The premium comes from Bitcoin volatility that the contract measures itself, on Mezo’s own price feed.',
    act: async (p) => {
      await p.getByRole('slider').focus()
      for (let i = 0; i < 6; i++) await p.keyboard.press('ArrowLeft')
      await p.locator('.quote').scrollIntoViewIfNeeded()
      await p.getByText('2 weeks', { exact: true }).click()
    },
  },
  { say: 'The odds are shown two ways: the on-chain volatility model, and a backtest over thirty days of Mezo’s oracle history.', act: (p) => p.locator('.odds').scrollIntoViewIfNeeded() },
  { say: 'If Bitcoin touches the strike, anyone can trigger it and earn a reward. The cover is paid straight into the loan, through Mezo’s repay with signature.', act: (p) => p.evaluate(() => window.scrollTo(0, 0)) },
  {
    say: 'MUSD holders fund the cover in a vault and earn the premiums. Every policy is fully backed, and at most half the vault is ever at risk.',
    act: async (p) => {
      await p.getByRole('button', { name: 'Earn by underwriting', exact: true }).click()
      await p.locator('.facts div', { hasText: 'Vault value' }).waitFor({ timeout: 60_000 })
    },
  },
  { say: 'Every vault event since launch, read from Mezo’s explorer, and a stress test of what each Bitcoin drop would pay out.', act: (p) => p.locator('.activity').scrollIntoViewIfNeeded().catch(() => {}) },
  {
    say: 'My cover lists each policy, with a live dry run of the repay into the loan, renewal links, and calendar reminders.',
    act: async (p) => {
      await p.getByRole('button', { name: 'My cover', exact: true }).click()
      await p.locator('main.policies tbody tr').first().waitFor({ timeout: 60_000 })
    },
  },
  { say: 'Signed phone alerts arrive even with the page closed. Bitcoin wallets sign theirs too, through Mezo Passport.', act: (p) => p.locator('.phone').scrollIntoViewIfNeeded().catch(() => {}) },
  { say: 'Payung is live on Mezo testnet, verified, and watched by a keeper. Payung: keep your Bitcoin dry.', act: (p) => p.locator('.horizon').scrollIntoViewIfNeeded() },
]

// Speak every line to a WAV first, so each scene knows how long it lasts. The text goes in through
// the environment, never into the PowerShell source.
const tool = (cmd, args, env) => { try { return execFileSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return null } }
const SPEAK = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:DEMO_VOICE); $s.Rate = 0; $s.SetOutputToWaveFile($env:DEMO_OUT); $s.Speak($env:DEMO_TEXT); $s.Dispose()'
let voiced = true
for (const [i, s] of scenes.entries()) {
  s.wav = resolve(`demo/voice/${i}.wav`)
  if (voiced && tool('powershell', ['-NoProfile', '-Command', SPEAK], { DEMO_VOICE: VOICE, DEMO_OUT: s.wav, DEMO_TEXT: s.say }) !== null) {
    s.seconds = Number(tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', s.wav]))
  }
  if (!s.seconds) voiced = false
}
console.log(voiced ? `narration: ${scenes.reduce((t, s) => t + s.seconds, 0).toFixed(1)} s in ${scenes.length} lines (${VOICE})` : 'no narration (needs Windows speech and ffmpeg): silent video')

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge' }) // Edge ships with Windows, as in playwright.config.mjs
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: 'demo/raw', size: SIZE } })
const page = await context.newPage()
const t0 = Date.now() // the recording starts with the page

// A caption bar over the page, set through the DOM (allowed under the app's CSP).
async function caption(text) {
  await page.evaluate((t) => {
    let bar = document.getElementById('demo-caption')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'demo-caption'
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 28px;background:rgba(25,11,7,0.9);color:#fff3e6;font:600 20px/1.35 system-ui,sans-serif;text-align:center'
      document.body.appendChild(bar)
    }
    bar.textContent = t
  }, text)
}

await page.goto(APP) // opens on the landing page, then views the team's loan
await page.locator('.stats dd', { hasText: '$' }).waitFor({ timeout: 60_000 })
await page.locator('.stats dd', { hasText: 'MUSD' }).first().waitFor({ timeout: 60_000 })
await page.waitForTimeout(800)
const now = () => (Date.now() - t0) / 1000
const kept = [] // stretches of the raw recording that make the video, [from, to] in seconds
let from
for (const s of scenes) {
  if (s.cut) kept.push([from, now()])
  if (s.act) await s.act(page)
  await page.waitForTimeout(400) // the scroll or tab settles before the line starts
  s.at = now()
  if (from === undefined || s.cut) from = s.at - 0.3
  s.out = kept.reduce((t, [a, b]) => t + b - a, 0) + s.at - from // where the line starts in the cut video
  await caption(s.say)
  await page.waitForTimeout(((s.seconds ?? 6) + 0.9) * 1000)
}
await page.waitForTimeout(1200) // a beat on the last frame
kept.push([from, now()])

const recording = page.video()
await context.close()
await browser.close()
const raw = await recording.path()
let out = 'demo/payung-demo.mp4'
const args = ['-v', 'error', '-y', '-i', raw]
// the kept stretches, joined: loading before the first scene and inside cut scenes is left out
const video = kept.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`)
let graph = `${video.join(';')};${kept.map((_, i) => `[v${i}]`).join('')}concat=n=${kept.length}:v=1:a=0[v]`
if (voiced) {
  // each line enters at its scene's moment in the cut video
  for (const s of scenes) args.push('-i', s.wav)
  const delays = scenes.map((s, i) => `[${i + 1}:a]adelay=${Math.round(s.out * 1000)}:all=1[a${i}]`)
  graph += `;${delays.join(';')};${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0[voice]`
}
args.push('-filter_complex', graph, '-map', '[v]')
if (voiced) args.push('-map', '[voice]', '-c:a', 'aac', '-b:a', '128k')
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out)
if (tool('ffmpeg', args) === null) {
  out = 'demo/payung-demo.webm' // no ffmpeg: keep the recording as it is
  rmSync(out, { force: true })
  renameSync(raw, out)
}
rmSync('demo/raw', { recursive: true, force: true })
console.log(out, `(${(now() - kept.reduce((t, [a, b]) => t + b - a, 0)).toFixed(1)} s of loading cut)`)
