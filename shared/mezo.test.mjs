// node --test shared
// autoRepayProblem decides whether a payout goes into the loan or the wallet, and a claim can't be
// redone. Only a real revert may count as "the repay would fail"; an RPC timeout must throw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseError, ContractFunctionRevertedError, TimeoutError } from 'viem'
import { autoRepayProblem, explorerReceipt, mezoAbi } from './mezo.js'

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
