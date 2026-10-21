// node --test shared
// autoRepayProblem decides whether a payout goes into the loan or the wallet, and a claim can't be
// redone. Only a real revert may count as "the repay would fail"; an RPC timeout must throw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseError, ContractFunctionRevertedError, TimeoutError } from 'viem'
import { autoRepayProblem, explorerReceipt, explorerLogs, mezoAbi } from './mezo.js'

const policy = { autoRepay: true, holder: '0x' + '1'.repeat(40), cover: 10n ** 20n, signature: '0x', sigDeadline: 2n ** 40n }
const client = (simulate) => ({
  readContract: async ({ functionName }) => (functionName === 'getEntireDebtAndColl' ? [1n, 5n * 10n ** 21n, 0n] : functionName === 'computeNominalCR' ? 1n : functionName === 'getApproxHint' ? ['0x' + '0'.repeat(40)] : ['0x' + '0'.repeat(40), '0x' + '0'.repeat(40)]),
  simulateContract: simulate,
})

test('a dry-run that succeeds means the repay is armed', async () => {
  assert.equal(await autoRepayProblem(client(async () => ({})), '0x' + '2'.repeat(40), policy), null)
})

test('a revert is reported as the reason', async () => {
  const revert = new ContractFunctionRevertedError({ abi: mezoAbi, functionName: 'repayMUSDWithSignature', message: 'BorrowerOperationsSignatures: Invalid signature' })
  const sim = async () => { throw new BaseError('simulate failed', { cause: revert }) }
  assert.equal(await autoRepayProblem(client(sim), '0x' + '2'.repeat(40), policy), 'BorrowerOperationsSignatures: Invalid signature')
})

test('an RPC timeout throws instead of sending the payout to the wallet', async () => {
  const sim = async () => { throw new BaseError('simulate failed', { cause: new TimeoutError({ body: {}, url: 'http://rpc' }) }) }
  await assert.rejects(autoRepayProblem(client(sim), '0x' + '2'.repeat(40), policy))
})

test('auto-repay off or past its deadline needs no dry-run', async () => {
  const never = async () => assert.fail('no dry-run expected')
  assert.equal(await autoRepayProblem(client(never), '0x', { ...policy, autoRepay: false }), 'auto-repay is off')
  assert.equal(await autoRepayProblem(client(never), '0x', { ...policy, sigDeadline: 1n }), 'signature deadline passed')
})

// Live check against Mezo's explorer: a known Payung poke, mined and successful.
test('the explorer fallback reads a mined transaction', async () => {
  const r = await explorerReceipt('0x7502c5dc6b4bfd2dd5c2c74ef7784cbc5d1ddaa4d56635d131f2192ec9b22096')
  assert.equal(r.status, 'success')
  assert.equal(r.blockNumber, 16261706n)
  assert.equal(r.logs[0].topics[0], '0xa324ec4bc92baa5a400c1d703b5385d493b731b33f31bb690a2c90179bbe5d77') // VolatilityObserved
})

// Live check: the explorer's whole-range getLogs returns the vault's cover sales, decoded.
test('explorerLogs reads every PolicyBought since deployment', async () => {
  const { payungAbi, ADDR } = await import('./mezo.js')
  const logs = await explorerLogs(ADDR.payung, payungAbi, 'PolicyBought', ADDR.payungBlock)
  assert.ok(logs.length >= 7)
  assert.ok(logs.every((l) => l.eventName === 'PolicyBought' && l.args.premium > 0n && l.timestamp > 0))
  assert.equal(logs[0].transactionHash, '0xa424f08e0c5ec3625a67798a0d84d815d572a502468b25b56a9201f4c41c007c') // first sale on v4
})

// Live check: Multicall3 on Mezo testnet answers batched reads in one eth_call, matching direct reads.
test('reads batch through Mezo testnet Multicall3', async () => {
  const { createPublicClient, http } = await import('viem')
  const { mezoTestnet, payungAbi, ADDR } = await import('./mezo.js')
  let posts = 0
  const transport = http(undefined, { onFetchRequest: () => { posts++ } })
  const batched = createPublicClient({ chain: mezoTestnet, batch: { multicall: true }, transport })
  const blockNumber = await batched.getBlockNumber()
  posts = 0
  const names = ['currentExpiry', 'policyCount', 'maxUtilization', 'totalLocked']
  const viaMulticall = await Promise.all(names.map((n) => batched.readContract({ address: ADDR.payung, abi: payungAbi, functionName: n, blockNumber })))
  assert.equal(posts, 1)
  const direct = createPublicClient({ chain: mezoTestnet, transport: http() })
  assert.deepEqual(viaMulticall, await Promise.all(names.map((n) => direct.readContract({ address: ADDR.payung, abi: payungAbi, functionName: n, blockNumber }))))
})

// Live check: past the explorer's 1,000-log cap. MUSD transfers on Mezo testnet run to many thousands;
// paging by block must return more than one page, in order, with no log twice.
test('explorerLogs pages past 1,000 logs without duplicates', async () => {
  const { parseAbi } = await import('viem')
  const { ADDR } = await import('./mezo.js')
  const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
  const logs = await explorerLogs(ADDR.musd, abi, 'Transfer', 16_000_000n)
  assert.ok(logs.length > 1000, `only ${logs.length}`)
  const keys = logs.map((l) => `${l.blockNumber}-${l.logIndex}`)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(logs.every((l, i) => i === 0 || l.blockNumber > logs[i - 1].blockNumber || (l.blockNumber === logs[i - 1].blockNumber && l.logIndex > logs[i - 1].logIndex)))
})

// Live check: the explorer's pages hold exactly what Mezo's own RPC returns for the same window.
test('explorerLogs matches eth_getLogs over the same blocks', async () => {
  const { createPublicClient, http, parseAbi, getAbiItem } = await import('viem')
  const { mezoTestnet, ADDR } = await import('./mezo.js')
  const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
  const pub = createPublicClient({ chain: mezoTestnet, transport: http() })
  const end = (await pub.getBlockNumber()) - 100n // let the explorer's indexer catch up
  const start = end - 9_000n // the RPC caps eth_getLogs at 10,000 blocks
  const rpc = await pub.getLogs({ address: ADDR.musd, event: getAbiItem({ abi, name: 'Transfer' }), fromBlock: start, toBlock: end })
  const explorer = (await explorerLogs(ADDR.musd, abi, 'Transfer', start)).filter((l) => l.blockNumber <= end)
  assert.deepEqual(explorer.map((l) => `${l.transactionHash}-${l.logIndex}`), rpc.map((l) => `${l.transactionHash}-${l.logIndex}`))
})

test('redemptionQueue matches a walk of Mezo testnet\'s sorted troves', async () => {
  const { createPublicClient, http, parseAbi } = await import('viem')
  const { mezoTestnet, ADDR, redemptionQueue } = await import('./mezo.js')
  const c = createPublicClient({ chain: mezoTestnet, transport: http() })
  const abi = parseAbi(['function getLast() view returns (address)', 'function getPrev(address) view returns (address)', 'function getSize() view returns (uint256)'])
  const lowest = await c.readContract({ address: ADDR.sortedTroves, abi, functionName: 'getLast' })
  const second = await c.readContract({ address: ADDR.sortedTroves, abi, functionName: 'getPrev', args: [lowest] })
  const third = await c.readContract({ address: ADDR.sortedTroves, abi, functionName: 'getPrev', args: [second] })
  const debt = async (who) => { const [, p, i] = await c.readContract({ address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [who] }); return p + i }
  const [q, none, size, d1, d2] = await Promise.all([redemptionQueue(c, third), redemptionQueue(c, '0x' + '0'.repeat(39) + '1'), c.readContract({ address: ADDR.sortedTroves, abi, functionName: 'getSize' }), debt(lowest), debt(second)])
  assert.equal(q.ahead, 2n)
  assert.equal(q.total, size)
  assert.ok(q.debtAhead >= d1 + d2 && q.debtAhead - (d1 + d2) < 10n ** 18n) // interest accrues between calls
  assert.equal(none.ahead, none.total) // no loan: nothing to redeem
})
