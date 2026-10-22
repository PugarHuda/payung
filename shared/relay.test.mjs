// What Payung's relayer accepts and refuses, against OrangeKit's live factory on Mezo testnet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, slice, toHex, zeroAddress } from 'viem'
import { mezoTestnet, ADDR, mezoAbi } from './mezo.js'
import { relayProblem, ORANGEKIT_FACTORY } from './relay.js'

const client = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })
const RELAYER = '0xb947AF40FE314a2B71f641083d93079Ba35D944d'
const owner = slice(keccak256(toHex(`payung relay test ${Date.now()}`)), 0, 20) // a Bitcoin key hash nobody has used
const factoryAbi = parseAbi(['function deploySafe(bytes20)', 'function predictAddresses(bytes20) view returns (address safe, address owner)'])
const safeAbi = parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)'])
const approve = encodeFunctionData({ abi: mezoAbi, functionName: 'approve', args: [ADDR.payung, 1n] })
const exec = (target, { value = 0n, operation = 0, gasPrice = 0n } = {}) =>
  encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [target, value, approve, operation, 0n, 0n, gasPrice, zeroAddress, zeroAddress, '0x'] })

test('relays a new Bitcoin owner\'s Safe deployment (it simulates)', async () => {
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'deploySafe', args: [owner] })
  assert.equal(await relayProblem(client, RELAYER, { to: ORANGEKIT_FACTORY, data, owner }), null)
})

test('refuses a deployment for another owner than the one named', async () => {
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'deploySafe', args: [owner] })
  assert.equal(await relayProblem(client, RELAYER, { to: ORANGEKIT_FACTORY, data, owner: slice(keccak256('0x01'), 0, 20) }), 'deploys a different owner')
})

test('refuses anything that is not the named owner\'s Safe, or calls outside Payung, or delegatecalls', async () => {
  const [safe] = await client.readContract({ address: ORANGEKIT_FACTORY, abi: factoryAbi, functionName: 'predictAddresses', args: [owner] })
  assert.equal(await relayProblem(client, RELAYER, { to: ADDR.musd, data: approve, owner }), 'not a Safe deployment or Safe transaction')
  assert.equal(await relayProblem(client, RELAYER, { to: ADDR.payung, data: exec(ADDR.musd), owner }), "not this Bitcoin owner's OrangeKit Safe")
  assert.equal(await relayProblem(client, RELAYER, { to: safe, data: exec(ADDR.musd, { operation: 1 }), owner }), 'only plain calls without value')
  assert.equal(await relayProblem(client, RELAYER, { to: safe, data: exec(ADDR.musd, { value: 1n }), owner }), 'only plain calls without value')
  assert.equal(await relayProblem(client, RELAYER, { to: safe, data: exec(ADDR.musd, { gasPrice: 1n }), owner }), 'no gas refunds')
  assert.equal(await relayProblem(client, RELAYER, { to: safe, data: exec(ADDR.troveManager), owner }), 'calls a contract outside Payung')
  // In scope, but the Safe doesn't exist yet: a call to it would be a paid no-op.
  assert.equal(await relayProblem(client, RELAYER, { to: safe, data: exec(ADDR.musd), owner }), 'Safe not deployed yet')
  assert.equal(await relayProblem(client, RELAYER, { to: 'nope', data: '0x', owner }), 'bad request')
})

test('inside a Safe transaction, only what using Payung needs: no transfers, no foreign spenders, swaps pay the account', async () => {
  const { innerCallProblem } = await import('./relay.js')
  const { payungAbi, poolsAbi } = await import('./mezo.js')
  const safe = '0x00000000000000000000000000000000000000aa'
  const other = '0x00000000000000000000000000000000000000bb'
  const erc20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)'])
  const enc = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args })
  const route = [{ from: ADDR.btc, to: ADDR.musd, stable: false, factory: ADDR.poolsFactory }]
  assert.equal(innerCallProblem(safe, ADDR.payung, enc(payungAbi, 'claim', [1n, zeroAddress, zeroAddress])), null)
  assert.equal(innerCallProblem(safe, ADDR.payungV1, enc(payungAbi, 'withdraw', [1n, safe, safe])), null)
  assert.equal(innerCallProblem(safe, ADDR.payung, '0xdeadbeef'), 'not a Payung function')
  assert.equal(innerCallProblem(safe, ADDR.musd, enc(erc20, 'approve', [ADDR.payung, 1n])), null)
  assert.equal(innerCallProblem(safe, ADDR.musd, enc(erc20, 'approve', [other, 1n])), 'approves a spender outside Payung')
  assert.equal(innerCallProblem(safe, ADDR.musd, enc(erc20, 'transfer', [other, 1n])), 'only approvals on MUSD and BTC')
  assert.equal(innerCallProblem(safe, ADDR.btc, enc(erc20, 'approve', [ADDR.poolsRouter, 1n])), null)
  assert.equal(innerCallProblem(safe, ADDR.btc, enc(erc20, 'approve', [ADDR.payung, 1n])), 'approves a spender outside Payung')
  assert.equal(innerCallProblem(safe, ADDR.poolsRouter, enc(poolsAbi, 'swapExactTokensForTokens', [1n, 1n, route, safe, 1n])), null)
  assert.equal(innerCallProblem(safe, ADDR.poolsRouter, enc(poolsAbi, 'swapExactTokensForTokens', [1n, 1n, route, other, 1n])), 'the swap must pay the account itself')
  assert.equal(innerCallProblem(safe, ADDR.troveManager, '0x'), 'calls a contract outside Payung')
})
