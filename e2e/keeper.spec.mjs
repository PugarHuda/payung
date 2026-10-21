// The keeper's redemption-queue alert, on an anvil fork of Mezo testnet with the real MUSD system
// and the real Payung vault. A covered borrower withdraws collateral until their loan has the lowest
// collateral ratio of all (first in Mezo's redemption queue); the real keeper.mjs must notice and
// send them a signed phone alert. Needs no wallet key: the borrower is impersonated on the fork.
//   npx playwright test keeper
import { test, expect } from '@playwright/test'
import { spawn, execSync } from 'node:child_process'
import { createPublicClient, createWalletClient, http, parseAbi, numberToHex, pad } from 'viem'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, redemptionQueue } from '../shared/mezo.js'
import { readAlerts } from '../shared/notify.js'

const RPC = 'http://127.0.0.1:8787'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil's first dev account
const ANVIL_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BORROWER_OPS = '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5'
const RETURN_SLOT0 = '0x60005460005260206000f3' // PriceFeed stand-in: return sload(0) (anvil can't run Mezo's oracle precompile)

test.describe('the keeper on a fork of Mezo testnet', () => {
  let anvil
  // Long timeout: the first walk of the redemption queue pulls every trove's storage over the fork.
  const fork = createPublicClient({ chain: mezoTestnet, transport: http(RPC, { timeout: 900_000 }) })

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    if (await fetch(RPC).then(() => true, () => false)) throw new Error(`${RPC} is already in use; stop that process first`)
    anvil = spawn('anvil --fork-url https://rpc.test.mezo.org --port 8787 --chain-id 31611 --gas-limit 60000000 --silent', { shell: true, stdio: 'ignore' })
    for (const end = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 500))) {
      if (await fork.getBlockNumber().then(() => true, () => false)) break
      if (Date.now() > end) throw new Error('anvil did not start')
    }
    await fork.request({ method: 'anvil_mine', params: ['0x1'] }) // Mezo headers lack blob-gas fields; a local block has them
  })

  test.afterAll(() => {
    if (!anvil) return
    if (process.platform === 'win32') execSync(`taskkill /pid ${anvil.pid} /T /F`, { stdio: 'ignore' })
    else anvil.kill()
  })

  test('alerts a covered borrower who reaches the front of the redemption queue', async () => {
    test.setTimeout(1_200_000)
    // Pin the oracle at today's live price so Mezo's own checks run on the fork.
    const price = await createPublicClient({ chain: mezoTestnet, transport: http() }).readContract({ address: ADDR.priceFeed, abi: mezoAbi, functionName: 'fetchPrice' })
    await fork.request({ method: 'anvil_setCode', params: [ADDR.priceFeed, RETURN_SLOT0] })
    await fork.request({ method: 'anvil_setStorageAt', params: [ADDR.priceFeed, '0x0', pad(numberToHex(price))] })

    // A holder of live cover who has a Mezo loan.
    const read = (functionName, args = []) => fork.readContract({ address: ADDR.payung, abi: payungAbi, functionName, args })
    const now = BigInt(Math.floor(Date.now() / 1000))
    const count = await read('policyCount')
    let holder
    for (let id = count - 1n; id >= 0n && !holder; id--) {
      const p = await read('policy', [id])
      if (p.claimed || p.expiry <= now) continue
      const status = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getTroveStatus', args: [p.holder] })
      if (status === 1n) holder = p.holder
    }
    expect(holder, 'no live policy holder with a Mezo loan').toBeTruthy()

    // Withdraw collateral down to 111% (Mezo's floor is 110%): below every other loan on testnet.
    const [coll, principal, interest] = await fork.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [holder] })
    const keep = ((principal + interest) * 111n * 10n ** 16n) / price
    expect(coll).toBeGreaterThan(keep)
    await fork.request({ method: 'anvil_setBalance', params: [holder, numberToHex(10n ** 18n)] })
    await fork.request({ method: 'anvil_impersonateAccount', params: [holder] })
    const borrower = createWalletClient({ account: holder, chain: mezoTestnet, transport: http(RPC) })
    // Exact hints for its new place, the tail (searching the list would pull every trove's storage over the fork).
    const upper = await fork.readContract({ address: ADDR.sortedTroves, abi: parseAbi(['function getLast() view returns (address)']), functionName: 'getLast' })
    const lower = '0x0000000000000000000000000000000000000000'
    const hash = await borrower.writeContract({ address: BORROWER_OPS, abi: parseAbi(['function withdrawColl(uint256 amount, address upperHint, address lowerHint)']), functionName: 'withdrawColl', args: [coll - keep, upper, lower], gas: 15_000_000n })
    expect((await fork.waitForTransactionReceipt({ hash })).status).toBe('success')
    const q = await redemptionQueue(fork, holder)
    expect(q.ahead).toBe(0n) // first in line

    // The real keeper, one pass, alerts in this run's own ntfy namespace (not the holder's real topic).
    const NTFY_PREFIX = `payung-e2e-${Date.now().toString(36)}-`
    console.log(execSync('node keeper/keeper.mjs --once', { env: { ...process.env, KEEPER_KEY: ANVIL_KEY, MEZO_RPC: RPC, NTFY_PREFIX }, encoding: 'utf8' }).trim())
    const tag = `redeem-${holder.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`
    const find = async () => (await readAlerts(holder, NTFY_PREFIX)).find((a) => a.tag === tag)
    await expect.poll(async () => (await find())?.signer, { message: 'no keeper-signed redemption alert', timeout: 15_000 }).toBe(ANVIL_ADDR)
    const alert = await find()
    expect(alert.title).toBe(`Your Mezo loan is 1 of ${q.total.toLocaleString('en-US')} in the redemption queue`)
    expect(alert.message).toMatch(/^Only 0 MUSD of debt is ahead of it; Mezo's largest redemption was [\d,]+ MUSD\./)
    expect(alert.priority).toBe(4)
  })
})
