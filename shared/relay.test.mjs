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
