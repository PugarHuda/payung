// One-shot testnet demo: underwrite, then insure the same wallet's trove with auto-repay.
//   PRIVATE_KEY=0x... node demo.mjs
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayTypedData, waitForReceipt, GAS } from '../shared/mezo.js'

const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const pub = createPublicClient({ chain: mezoTestnet, transport: http() })
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http() })
const payung = process.env.PAYUNG ?? ADDR.payung
const read = (functionName, args = []) => pub.readContract({ address: payung, abi: payungAbi, functionName, args })

async function tx(label, address, abi, functionName, args) {
  const req = { account, address, abi, functionName, args }
  const hash = await wallet.writeContract({ ...req, gas: GAS })
  const r = await waitForReceipt(pub, hash)
  console.log(`${label}: ${r.status} ${mezoTestnet.blockExplorers.default.url}/tx/${hash}`)
  if (r.status !== 'success') process.exit(1)
}

const deposit = parseUnits(process.env.DEPOSIT ?? '1500', 18)
const cover = parseUnits(process.env.COVER ?? '500', 18)

await tx('approve', ADDR.musd, mezoAbi, 'approve', [payung, deposit + cover])
await tx('deposit', payung, payungAbi, 'deposit', [deposit, account.address])

const price = await pub.readContract({ address: ADDR.priceFeed, abi: mezoAbi, functionName: 'fetchPrice' })
const step = 1000n * 10n ** 18n
const strike = ((price * 88n) / 100n / step) * step // ~12% below spot
const expiry = (await read('currentExpiry')) + BigInt(Number(process.env.WEEKS ?? 1) - 1) * 604800n // WEEKS=1..4
const [premium, distance] = await read('quote', [expiry, strike, cover])
const deadline = expiry + 86400n
const nonce = await pub.readContract({ address: ADDR.sigs, abi: mezoAbi, functionName: 'getNonce', args: [account.address] })
const signature = await wallet.signTypedData(repayTypedData({ amount: cover, borrower: account.address, nonce, deadline }))
console.log(`strike $${formatUnits(strike, 18)} (${Number(distance) / 100}% below), premium ${formatUnits(premium, 18)} MUSD`)
const maxPremium = (premium * 101n) / 100n // 1% slippage guard
await tx('buy', payung, payungAbi, 'buy', [expiry, strike, cover, maxPremium, true, deadline, signature])

console.log('NAV', formatUnits(await read('totalAssets'), 18), '· free', formatUnits(await read('freeLiquidity'), 18))
