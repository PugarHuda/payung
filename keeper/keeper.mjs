// Payung keeper: triggers touched strikes, pays policies (into troves when pre-signed) and feeds
// the on-chain volatility estimate. Every action is permissionless; anyone can run this. Usage:
//   KEEPER_KEY=0x... [PAYUNG=0x...] [MEZO_RPC=http://...] node keeper.mjs [--once | --for <seconds>]
// --once runs a single pass; --for keeps polling for that long and exits (the GitHub Actions
// cron in .github/workflows/keeper.yml runs --for 270 every 5 minutes: near-continuous watch).
import { createPublicClient, createWalletClient, http, formatUnits, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayHints, autoRepayProblem, waitForReceipt, GAS } from '../shared/mezo.js'
import { notify, readAlerts } from '../shared/notify.js'

const payung = process.env.PAYUNG ?? ADDR.payung
const account = privateKeyToAccount(process.env.KEEPER_KEY)
const rpc = http(process.env.MEZO_RPC, { timeout: 60_000 }) // unset: Mezo testnet's public RPC; a repay dry-run can take a while
const pub = createPublicClient({ chain: mezoTestnet, batch: { multicall: true }, transport: rpc }) // parallel reads -> one Multicall3 eth_call
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: rpc })
const read = (functionName, args = []) => pub.readContract({ address: payung, abi: payungAbi, functionName, args })
const ZERO = '0x0000000000000000000000000000000000000000'
const POLL_MS = Number(process.env.POLL_MS ?? 5_000) // a touch counts only if someone looks while BTC is below the strike
const OBSERVE_INTERVAL = 15n * 60n
const ALERT_BAND = 103n // phone alert when BTC is within 3% of a live strike (as in the app)
const usd = (v) => '$' + Math.round(Number(formatUnits(v, 18))).toLocaleString('en-US')
const alerted = new Set() // this process; across runs, this keeper's own signed alerts in ntfy's 12-hour cache

// An alert that fails (ntfy down) is logged, never allowed to stop a trigger or a payout.
async function alert(holder, msg) {
  if (alerted.has(msg.tag)) return
  alerted.add(msg.tag)
  try {
    // Only alerts this keeper signed count: anyone can post to a topic, so a bare tag proves nothing.
    if ((await readAlerts(holder)).some((a) => a.tag === msg.tag && a.signer === account.address)) return
    await notify(holder, msg, account)
    console.log(`alerted ${holder}: ${msg.title}`)
  } catch (e) {
    console.error(`alert failed: ${e.message}`)
  }
}

async function send(functionName, args) {
  const req = { account, address: payung, abi: payungAbi, functionName, args }
  await pub.simulateContract(req) // surface the revert reason instead of burning gas on it
  const hash = await wallet.writeContract({ ...req, gas: GAS })
  const receipt = await waitForReceipt(pub, hash)
  console.log(`${functionName}(${args.join(', ')}) -> ${receipt.status} ${mezoTestnet.blockExplorers.default.url}/tx/${hash}`)
  return receipt
}

let scanFrom = 0n // policies below this index are already paid
let lastLog = 0

async function tick() {
  const [price, first, weeks] = await Promise.all([
    pub.readContract({ address: ADDR.priceFeed, abi: mezoAbi, functionName: 'fetchPrice' }),
    read('currentExpiry'),
    read('MAX_WEEKS'),
  ])

  // A touch hits every live expiry that sold the strike; each is its own trigger (and reward).
  const expiries = Array.from({ length: Number(weeks) }, (_, w) => first + BigInt(w) * 604800n)
  const lists = await Promise.all(expiries.map((e) => read('strikeList', [e])))
  const touched = lists.flatMap((list, i) => list.filter((strike) => price <= strike).map((strike) => [expiries[i], strike]))
  const states = await Promise.all(touched.map((args) => read('strikes', args)))
  for (const [i, [cover, triggered]] of states.entries()) if (!triggered && cover > 0n) await send('trigger', touched[i])

  const count = await read('policyCount')
  let allPaidBelow = scanFrom
  const ids = Array.from({ length: Number(count - scanFrom) }, (_, i) => scanFrom + BigInt(i))
  const policies = await Promise.all(ids.map((id) => read('policy', [id])))
  for (const [i, p] of policies.entries()) {
    const id = ids[i]
    if (p.claimed) {
      if (allPaidBelow === id) allPaidBelow = id + 1n
      continue
    }
    const [, triggered] = await read('strikes', [p.expiry, p.strike])
    if (!triggered) {
      if (BigInt(Math.floor(Date.now() / 1000)) < p.expiry && price * 100n <= p.strike * ALERT_BAND) {
        await alert(p.holder, {
          tag: `near-${payung.toLowerCase()}-${id}`,
          title: `BTC is ${usd(price)}, within 3% of your ${usd(p.strike)} strike`,
          message: `If it touches before ${new Date(Number(p.expiry) * 1000).toUTCString()}, ${Number(formatUnits(p.cover, 18))} MUSD goes ${p.autoRepay ? 'into your Mezo loan' : 'to your wallet'}.`,
        })
      }
      continue
    }
    const problem = await autoRepayProblem(pub, payung, p)
    if (p.autoRepay && problem) console.log(`policy ${id}: repay would fail (${problem}), paying the wallet`)
    const [upper, lower] = p.autoRepay && !problem ? await repayHints(pub, p.holder, p.cover) : [ZERO, ZERO]
    const receipt = await send('claim', [id, upper, lower])
    const [paid] = parseEventLogs({ abi: payungAbi, eventName: 'PolicyPaid', logs: receipt.logs })
    if (paid) {
      await alert(p.holder, {
        tag: `paid-${payung.toLowerCase()}-${id}`,
        title: `Payung paid your ${usd(p.strike)} cover`,
        message: `BTC touched ${usd(p.strike)}. ${Number(formatUnits(p.cover, 18))} MUSD went ${paid.args.repaidTrove ? 'into your Mezo loan' : 'to your wallet'}.`,
      })
    }
  }
  scanFrom = allPaidBelow

  // Read these last: trigger() above also takes a sample. Chain time, not this machine's clock,
  // because poke() checks block.timestamp.
  const [observedAt, { timestamp: now }] = await Promise.all([read('lastObservedAt'), pub.getBlock()])
  if (now - observedAt >= OBSERVE_INTERVAL) await send('poke', [])

  if (Date.now() - lastLog > 60_000) {
    lastLog = Date.now()
    const vol = await read('volatility')
    console.log(`[${new Date().toISOString()}] BTC $${Number(formatUnits(price, 18)).toFixed(0)} · vol ${Number(formatUnits(vol, 16)).toFixed(1)}% · policies ${count}`)
  }
}

if (process.argv.includes('--once')) {
  await tick() // throws -> non-zero exit, so a failing cron run shows red
  process.exit(0)
}

const forIdx = process.argv.indexOf('--for')
const stopAt = forIdx > 0 ? Date.now() + Number(process.argv[forIdx + 1]) * 1000 : Infinity
let ticks = 0
let failures = 0
while (Date.now() < stopAt) {
  ticks++
  try {
    await tick()
  } catch (e) {
    failures++
    console.error(e.shortMessage ?? e.message) // stale oracle, RPC hiccup: retry next tick
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
process.exit(failures * 2 > ticks ? 1 : 0) // mostly failing (e.g. RPC down) -> red cron run
