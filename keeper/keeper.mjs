// Payung keeper: triggers touched strikes, pays policies (into troves when pre-signed) and feeds
// the on-chain volatility estimate. Every action is permissionless; anyone can run this. Usage:
//   KEEPER_KEY=0x... PAYUNG=0x... node keeper.mjs [--once]
// --once runs a single pass (the GitHub Actions cron in .github/workflows/keeper.yml).
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayHints, autoRepayProblem, GAS } from '../shared/mezo.js'

const payung = process.env.PAYUNG ?? ADDR.payung
const account = privateKeyToAccount(process.env.KEEPER_KEY)
const pub = createPublicClient({ chain: mezoTestnet, transport: http() })
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http() })
const read = (functionName, args = []) => pub.readContract({ address: payung, abi: payungAbi, functionName, args })
const ZERO = '0x0000000000000000000000000000000000000000'
const POLL_MS = 5_000 // a one-touch is only caught if someone looks while BTC is below the strike
const OBSERVE_INTERVAL = 15n * 60n

async function send(functionName, args) {
  const req = { account, address: payung, abi: payungAbi, functionName, args }
  await pub.simulateContract(req) // surface the revert reason instead of burning gas on it
  const hash = await wallet.writeContract({ ...req, gas: GAS })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`${functionName}(${args.join(', ')}) -> ${receipt.status} ${mezoTestnet.blockExplorers.default.url}/tx/${hash}`)
}

let scanFrom = 0n // policies below this index are already paid
let lastLog = 0

async function tick() {
  const [price, expiry, observedAt] = await Promise.all([
    pub.readContract({ address: ADDR.priceFeed, abi: mezoAbi, functionName: 'fetchPrice' }),
    read('activeExpiry'),
    read('lastObservedAt'),
  ])
  const now = BigInt(Math.floor(Date.now() / 1000))

  if (now < expiry) {
    for (const strike of await read('strikeList', [expiry])) {
      const [cover, triggered] = await read('strikes', [expiry, strike])
      if (!triggered && cover > 0n && price <= strike) await send('trigger', [strike])
    }
  }

  const count = await read('policyCount')
  let allPaidBelow = scanFrom
  for (let id = scanFrom; id < count; id++) {
    const p = await read('policy', [id])
    if (p.claimed) {
      if (allPaidBelow === id) allPaidBelow = id + 1n
      continue
    }
    const [, triggered] = await read('strikes', [p.expiry, p.strike])
    if (!triggered) continue
    const problem = await autoRepayProblem(pub, payung, p)
    if (p.autoRepay && problem) console.log(`policy ${id}: repay would fail (${problem}), paying the wallet`)
    const [upper, lower] = p.autoRepay && !problem ? await repayHints(pub, p.holder, p.cover) : [ZERO, ZERO]
    await send('claim', [id, upper, lower])
  }
  scanFrom = allPaidBelow

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

for (;;) {
  try {
    await tick()
  } catch (e) {
    console.error(e.shortMessage ?? e.message) // stale oracle, RPC hiccup: retry next tick
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
