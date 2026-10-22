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
import { ADDR, GAS, payungAbi, poolsAbi, waitForReceipt } from './mezo.js'

export const ORANGEKIT_FACTORY = '0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052' // same address on every chain
const factoryAbi = parseAbi([
  'function deploySafe(bytes20 truncatedBitcoinAddress) returns (address)',
  'function predictAddresses(bytes20 truncatedBitcoinAddress) view returns (address safe, address owner)',
])
const safeAbi = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
])
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const same = (a, b) => getAddress(a) === getAddress(b) // not .map(getAddress) anywhere: the index would become a chain id (EIP-1191)

/** Why the Safe's own call (`target`, `data`) is outside what Payung needs, or null. Only these:
 *  anything on Payung (v2, or v1 to withdraw and claim), MUSD approved to Payung, BTC approved to
 *  the Mezo Pools router, and a swap on the router that pays the Safe itself. No transfers. */
export function innerCallProblem(safe, target, data) {
  const decode = (abi) => {
    try {
      return decodeFunctionData({ abi, data })
    } catch {
      return null
    }
  }
  if (same(target, ADDR.payung) || same(target, ADDR.payungV1)) return decode(payungAbi) ? null : 'not a Payung function'
  if (same(target, ADDR.musd) || same(target, ADDR.btc)) {
    const call = decode(erc20Abi)
    if (call?.functionName !== 'approve') return 'only approvals on MUSD and BTC'
    const ok = same(target, ADDR.musd) ? [ADDR.payung, ADDR.payungV1] : [ADDR.poolsRouter]
    return ok.some((s) => same(s, call.args[0])) ? null : 'approves a spender outside Payung'
  }
  if (same(target, ADDR.poolsRouter)) {
    const call = decode(poolsAbi)
    if (call?.functionName !== 'swapExactTokensForTokens') return 'only swaps on Mezo Pools'
    return same(call.args[3], safe) ? null : 'the swap must pay the account itself'
  }
  return 'calls a contract outside Payung'
}

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
    const [target, value, inner, operation, , , gasPrice] = call.args
    if (operation !== 0 || value !== 0n) return 'only plain calls without value'
    if (gasPrice !== 0n) return 'no gas refunds'
    const outside = innerCallProblem(to, target, inner)
    if (outside) return outside
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
  // One relayer key serves everyone: a concurrent request (or a lagging node) can hand two sends
  // the same nonce. The account's nonce manager orders them in this instance; a clash with another
  // instance is retried once with a fresh nonce.
  const send = () => wallet.sendTransaction({ to: req.to, data: req.data, gas: GAS })
  let hash
  try {
    hash = await send()
  } catch (e) {
    if (!/nonce|replacement|already known/i.test(e.details ?? e.message ?? '')) throw e
    wallet.account.nonceManager?.reset({ address: wallet.account.address, chainId: wallet.chain.id })
    hash = await send()
  }
  // OrangeKit reads the new Safe right after deploying it, so answer only once it is mined, and,
  // after a deployment, once the RPC (load-balanced, sometimes a block behind) serves its code.
  const receipt = await waitForReceipt(client, hash)
  if (receipt.status !== 'success') throw Object.assign(new Error(`reverted on-chain: ${hash}`), { status: 502 })
  if (getAddress(req.to) === ORANGEKIT_FACTORY) {
    const [safe] = await client.readContract({ address: ORANGEKIT_FACTORY, abi: factoryAbi, functionName: 'predictAddresses', args: [req.owner] })
    for (let i = 0; i < 30 && !(await client.getCode({ address: safe })); i++) await new Promise((r) => setTimeout(r, 1000))
  }
  return hash
}
