// Payung keeper: triggers touched strikes and pays policies (into troves when pre-signed).
// Every action is permissionless; anyone can run this. Usage:
//   KEEPER_KEY=0x... PAYUNG=0x... node keeper.mjs
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayHints, GAS } from '../shared/mezo.js'

const payung = process.env.PAYUNG ?? ADDR.payung
const account = privateKeyToAccount(process.env.KEEPER_KEY)
const pub = createPublicClient({ chain: mezoTestnet, transport: http() })
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http() })
const read = (functionName, args = []) => pub.readContract({ address: payung, abi: payungAbi, functionName, args })

async function send(functionName, args) {
  const req = { account, address: payung, abi: payungAbi, functionName, args }
  const hash = await wallet.writeContract({ ...req, gas: GAS })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`${functionName}(${args.join(', ')}) -> ${receipt.status} ${hash}`)
}

let scanFrom = 0n // policies below this index are already paid

async function tick() {
  const [price, expiry] = await Promise.all([
    pub.readContract({ address: ADDR.priceFeed, abi: mezoAbi, functionName: 'fetchPrice' }),
    read('activeExpiry'),
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
    const zero = '0x0000000000000000000000000000000000000000'
    const [upper, lower] = p.autoRepay ? await repayHints(pub, p.holder, p.cover) : [zero, zero]
    await send('claim', [id, upper, lower])
  }
  scanFrom = allPaidBelow
  console.log(`[${new Date().toISOString()}] BTC $${Number(formatUnits(price, 18)).toFixed(0)} · policies ${count}`)
}

for (;;) {
  try {
    await tick()
  } catch (e) {
    console.error(e.shortMessage ?? e.message) // stale oracle, RPC hiccup: retry next tick
  }
  await new Promise((r) => setTimeout(r, 30_000))
}
