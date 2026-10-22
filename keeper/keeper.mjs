// Payung keeper: triggers touched strikes, pays policies (into troves when pre-signed) and feeds
// the on-chain volatility estimate. Every action is permissionless; anyone can run this. Usage:
//   KEEPER_KEY=0x... [PAYUNG=0x...] [MEZO_RPC=http://...] node keeper.mjs [--once | --for <seconds>]
// --once runs a single pass; --for keeps polling for that long and exits (the GitHub Actions
// workflow in .github/workflows/keeper.yml runs --for 20700 back to back: a continuous watch).
import { createPublicClient, createWalletClient, http, formatUnits, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayHints, autoRepayProblem, redemptionQueue, redemptionHistory, waitForReceipt, GAS } from '../shared/mezo.js'
import { notify, readAlerts } from '../shared/notify.js'

// Every vault with live cover: the current one, and v1 until its last cover ends (one key, one
// loop, so the two never race for a nonce). PAYUNG=0x... watches just that one.
const vaults = process.env.PAYUNG ? [process.env.PAYUNG] : [ADDR.payung, ADDR.payungV1]
let payung = vaults[0] // the vault this tick works on; read() and send() use it
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

const scanFrom = new Map() // vault => policies below this index are done
let lastLog = 0
const lastQueueCheck = new Map()
const queueWatch = new Map() // vault => redemption-queue check in flight
const QUEUE_CHECK_MS = 10 * 60_000 // the queue moves with loans, not with every price tick

// Payung covers liquidation, not redemption, so tell a covered borrower when one redemption the
// size of the largest Mezo has processed would reach their loan (at most once a day per loan).
async function watchRedemptions(holders) {
  const history = await redemptionHistory()
  const largest = history.reduce((m, r) => (r.amount > m ? r.amount : m), 0n)
  for (const holder of holders) {
    const q = await redemptionQueue(pub, holder)
    if (q.ahead === q.total || q.debtAhead >= largest) continue // no loan, or out of reach
    await alert(holder, {
      tag: `redeem-${holder.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`,
      priority: 4,
      title: `Your Mezo loan is ${(q.ahead + 1n).toLocaleString('en-US')} of ${q.total.toLocaleString('en-US')} in the redemption queue`,
      message: `Only ${Math.round(Number(formatUnits(q.debtAhead, 18))).toLocaleString('en-US')} MUSD of debt is ahead of it; Mezo's largest redemption was ${Math.round(Number(formatUnits(largest, 18))).toLocaleString('en-US')} MUSD. A redemption repays your debt with your BTC. Payung does not cover it; a higher collateral ratio moves you back.`,
    })
  }
}

let lastGasWarn = 0

async function tick() {
  let failed = 0
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
  // One failed trigger (an app user got there first, an RPC hiccup) must not hold up the rest.
  for (const [i, [cover, triggered]] of states.entries()) {
    if (triggered || cover === 0n) continue
    await send('trigger', touched[i]).catch((e) => { failed++; console.error(`trigger ${touched[i].join(' ')} failed: ${e.shortMessage ?? e.message}`) })
  }

  const count = await read('policyCount')
  const from = scanFrom.get(payung) ?? 0n
  let allPaidBelow = from
  const ids = Array.from({ length: Number(count - from) }, (_, i) => from + BigInt(i))
  const policies = await Promise.all(ids.map((id) => read('policy', [id])))
  const hit = await Promise.all(policies.map((p) => (p.claimed ? [0n, false] : read('strikes', [p.expiry, p.strike])))) // one multicall
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  for (const [i, p] of policies.entries()) {
    const id = ids[i]
    const triggered = hit[i][1]
    // Done for good: paid, or expired untouched (a strike can't be triggered after expiry).
    if (p.claimed || (!triggered && nowSec >= p.expiry)) {
      if (allPaidBelow === id) allPaidBelow = id + 1n
      continue
    }
    if (!triggered) {
      if (BigInt(Math.floor(Date.now() / 1000)) < p.expiry && price * 100n <= p.strike * ALERT_BAND) {
        await alert(p.holder, {
          tag: `near-${payung.toLowerCase()}-${id}`,
          priority: 5, // a loan may be minutes from liquidation: ring through Do Not Disturb
          title: `BTC is ${usd(price)}, within 3% of your ${usd(p.strike)} strike`,
          message: `If it touches before ${new Date(Number(p.expiry) * 1000).toUTCString()}, ${Number(formatUnits(p.cover, 18))} MUSD goes ${p.autoRepay ? 'into your Mezo loan' : 'to your wallet'}.`,
        })
      }
      continue
    }
    // A slow repay dry-run or a race on one policy must not stall every other payout.
    try {
      const problem = await autoRepayProblem(pub, payung, p)
      if (p.autoRepay && problem && nowSec <= p.sigDeadline) {
        // The contract lets only the holder take a failed repay to the wallet before FALLBACK_DELAY
        // (so nobody can starve a valid repay on purpose); the holder can still claim at once.
        // A vault deployed before FALLBACK_DELAY has neither getter and pays the wallet at once.
        const [at, delay] = await Promise.all([read('triggeredAt', [p.expiry, p.strike]), read('FALLBACK_DELAY')]).catch(() => [0n, 0n])
        if (nowSec < at + delay) {
          console.log(`policy ${id}: repay would fail (${problem}); the wallet payout opens to keepers at ${new Date(Number(at + delay) * 1000).toISOString()}`)
          continue
        }
      }
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
    } catch (e) {
      failed++
      console.error(`claim ${id} failed, retrying next tick: ${e.shortMessage ?? e.message}`)
    }
  }
  scanFrom.set(payung, allPaidBelow)

  // The queue walk reads every sorted trove: slow on a slow RPC. It runs beside the loop so it never
  // holds up a trigger, a payout or a volatility sample; at most one per vault at a time.
  if (!queueWatch.has(payung) && Date.now() - (lastQueueCheck.get(payung) ?? 0) > QUEUE_CHECK_MS) {
    lastQueueCheck.set(payung, Date.now())
    const now = BigInt(Math.floor(Date.now() / 1000))
    const covered = new Set(policies.filter((p) => !p.claimed && now < p.expiry).map((p) => p.holder))
    const vault = payung
    queueWatch.set(vault, watchRedemptions(covered)
      .catch((e) => console.error(`redemption watch failed: ${e.message}`))
      .finally(() => queueWatch.delete(vault)))
  }

  // Read these last: trigger() above also takes a sample. Chain time, not this machine's clock,
  // because poke() checks block.timestamp.
  const [observedAt, { timestamp: now }] = await Promise.all([read('lastObservedAt'), pub.getBlock()])
  if (payung === vaults[0] && now - observedAt >= OBSERVE_INTERVAL) await send('poke', []) // only the vault still selling cover needs vol

  if (Date.now() - lastLog > 60_000) {
    lastLog = Date.now()
    const [vol, gas, gasPrice] = await Promise.all([read('volatility'), pub.getBalance({ address: account.address }), pub.getGasPrice()])
    console.log(`[${new Date().toISOString()}] BTC $${Number(formatUnits(price, 18)).toFixed(0)} · vol ${Number(formatUnits(vol, 16)).toFixed(1)}% · policies ${count} · keeper gas ${formatUnits(gas, 18)} BTC`)
    // An empty keeper fails every trigger quietly; GitHub Actions shows ::warning:: on the run page.
    if (gas < gasPrice * GAS * 100n && Date.now() - lastGasWarn > 3_600_000) { // under 100 transactions left
      lastGasWarn = Date.now()
      console.log(`::warning::Keeper ${account.address} has ${formatUnits(gas, 18)} BTC left for gas. Top it up from faucet.test.mezo.org.`)
    }
  }
  if (failed) throw new Error(`${failed} trigger/claim call(s) failed this tick; the rest went through`)
}

if (process.argv.includes('--once')) {
  let failed
  for (const v of vaults) {
    payung = v
    await tick().catch((e) => (failed = e)) // every vault gets its pass even if one fails
  }
  await Promise.all(queueWatch.values()) // a single pass still finishes its queue check
  if (failed) throw failed // non-zero exit, so a failing cron run shows red
  process.exit(0)
}

const forIdx = process.argv.indexOf('--for')
const stopAt = forIdx > 0 ? Date.now() + Number(process.argv[forIdx + 1]) * 1000 : Infinity
let ticks = 0
let failures = 0
while (Date.now() < stopAt) {
  for (const v of vaults) {
    ticks++
    payung = v
    try {
      await tick()
    } catch (e) {
      failures++
      console.error(`${v}: ${e.shortMessage ?? e.message}`) // stale oracle, RPC hiccup: retry next tick
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
process.exit(failures * 2 > ticks ? 1 : 0) // mostly failing (e.g. RPC down) -> red cron run
