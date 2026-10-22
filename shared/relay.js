// Payung's relayer for Mezo Passport accounts. A Bitcoin wallet's Mezo account is an OrangeKit Safe
// whose transactions are signed by the Bitcoin key; someone with gas has to submit them. Mezo's
// own relay refuses other sites, so Payung relays them itself, but only:
//   - deploySafe on OrangeKit's factory (the account's first transaction), and
//   - execTransaction on a Safe the factory derives from the Bitcoin owner the caller names,
//     as a plain call (no delegatecall, no value) to one of Payung's contracts,
// and only if a simulation from the relayer succeeds. The Safe checks the Bitcoin signature itself,
// so the relayer can't forge anything; the worst a caller can do is spend the relayer's gas on
// Payung calls the owner signed.
import { decodeFunctionData, getAddress, isAddress, isHex, parseAbi } from 'viem'
import { ADDR, GAS, waitForReceipt } from './mezo.js'

export const ORANGEKIT_FACTORY = '0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052' // same address on every chain
const factoryAbi = parseAbi([
  'function deploySafe(bytes20 truncatedBitcoinAddress) returns (address)',
  'function predictAddresses(bytes20 truncatedBitcoinAddress) view returns (address safe, address owner)',
])
const safeAbi = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
])
/** What a relayed Safe transaction may call: Payung and what using it needs. */
export const RELAY_TARGETS = [ADDR.payung, ADDR.payungV1, ADDR.musd, ADDR.btc, ADDR.poolsRouter].map((a) => getAddress(a)) // not .map(getAddress): the index would become a chain id (EIP-1191)

/** Why `req` must not be relayed, or null. `req` is { to, data, owner } as the app sends it. */
export async function relayProblem(client, relayer, { to, data, owner } = {}) {
  if (!isAddress(to ?? '') || !isHex(data ?? '') || !isHex(owner ?? '') || owner.length !== 42) return 'bad request'
  let call
  try {
    call = decodeFunctionData({ abi: getAddress(to) === ORANGEKIT_FACTORY ? factoryAbi : safeAbi, data })
  } catch {
    return 'not a Safe deployment or Safe transaction'
  }
  if (call.functionName === 'deploySafe') {
    if (call.args[0] !== owner) return 'deploys a different owner'
  } else if (call.functionName === 'execTransaction') {
    const [safe] = await client.readContract({ address: ORANGEKIT_FACTORY, abi: factoryAbi, functionName: 'predictAddresses', args: [owner] })
    if (getAddress(safe) !== getAddress(to)) return "not this Bitcoin owner's OrangeKit Safe"
    const [target, value, , operation, , , gasPrice] = call.args
    if (operation !== 0 || value !== 0n) return 'only plain calls without value'
    if (gasPrice !== 0n) return 'no gas refunds'
    if (!RELAY_TARGETS.includes(getAddress(target))) return 'calls a contract outside Payung'
    // A call to an address without code "succeeds" as a no-op; OrangeKit deploys the Safe first.
    if (!(await client.getCode({ address: to }))) return 'Safe not deployed yet'
  } else return 'not a Safe deployment or Safe transaction'
  try {
    await client.call({ account: relayer, to, data, gas: GAS })
  } catch (e) {
    return `would revert: ${e.shortMessage ?? 'simulation failed'}`
  }
  return null
}

/** Checks, sends and waits for `req`; returns the transaction hash. Throws { status, message }. */
export async function relay(client, wallet, req) {
  const problem = await relayProblem(client, wallet.account.address, req)
  if (problem) throw Object.assign(new Error(problem), { status: 400 })
  const hash = await wallet.sendTransaction({ to: req.to, data: req.data, gas: GAS })
  // OrangeKit reads the new Safe right after deploying it, so answer only once it is mined.
  const receipt = await waitForReceipt(client, hash)
  if (receipt.status !== 'success') throw Object.assign(new Error(`reverted on-chain: ${hash}`), { status: 502 })
  return hash
}
