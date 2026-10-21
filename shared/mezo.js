// Shared by the keeper and the app. Mezo testnet (matsnet) addresses from github.com/mezo-org/musd.
import { defineChain, parseAbi, parseEventLogs, toEventSelector, getAbiItem, ContractFunctionRevertedError } from 'viem'
import payungAbi from '../payung.abi.json' with { type: 'json' }

export const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  // Deployed on Mezo testnet: lets a client batch its reads into one eth_call.
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 3669328 } },
  testnet: true,
})

export const ADDR = {
  payung: '0xdC66559C75c9950f8869e20A04C14494DF601d4d',
  payungBlock: 16259876n, // deployment block: share-price history starts here
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  oracle: '0x7b7c000000000000000000000000000000000015', // PriceFeed.oracle(): Mezo's Skip Connect precompile
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  sigs: '0xD757e3646AF370b15f32EB557F0F8380Df7D639e',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  sortedTroves: '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA',
}

export { payungAbi }

export const mezoAbi = parseAbi([
  'function fetchPrice() view returns (uint256)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256)',
  'function getTroveStatus(address) view returns (uint256)',
  'function getNonce(address) view returns (uint256)',
  'function getApproxHint(uint256 cr, uint256 numTrials, uint256 seed) view returns (address hint, uint256 diff, uint256 seedOut)',
  'function computeNominalCR(uint256 coll, uint256 debt) pure returns (uint256)',
  'function findInsertPosition(uint256 nicr, address prev, address next) view returns (address, address)',
  'function checkRecoveryMode(uint256 price) view returns (bool)',
  'function getTCR(uint256 price) view returns (uint256)',
  'function getCurrentICR(address borrower, uint256 price) view returns (uint256)',
  'function repayMUSDWithSignature(uint256 amount, address upperHint, address lowerHint, address borrower, bytes signature, uint256 deadline)',
])

export const EXPLORER_API = 'https://api.explorer.test.mezo.org/api/v2'

// EIP-712 for Mezo's BorrowerOperationsSignatures.repayMUSDWithSignature
export const repayTypedData = ({ amount, borrower, nonce, deadline }) => ({
  domain: { name: 'BorrowerOperationsSignatures', version: '1', chainId: 31611, verifyingContract: ADDR.sigs },
  types: {
    RepayMUSD: [
      { name: 'amount', type: 'uint256' },
      { name: 'borrower', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'RepayMUSD',
  message: { amount, borrower, nonce, deadline },
})

/// Sorted-trove hints for `borrower` after repaying `amount` (repay hits interest before principal).
export async function repayHints(client, borrower, amount) {
  const [coll, principal, interest] = await client.readContract({
    address: ADDR.troveManager, abi: mezoAbi, functionName: 'getEntireDebtAndColl', args: [borrower],
  })
  const principalCut = amount > interest ? amount - interest : 0n
  const newPrincipal = principal > principalCut ? principal - principalCut : 1n
  const nicr = await client.readContract({
    address: ADDR.hintHelpers, abi: mezoAbi, functionName: 'computeNominalCR', args: [coll, newPrincipal],
  })
  const [approx] = await client.readContract({
    address: ADDR.hintHelpers, abi: mezoAbi, functionName: 'getApproxHint', args: [nicr, 30n, 42n],
  })
  return client.readContract({
    address: ADDR.sortedTroves, abi: mezoAbi, functionName: 'findInsertPosition', args: [nicr, approx, approx],
  })
}

/// Dry-runs a policy's payout repay as the vault (eth_call from the vault, which holds the MUSD
/// Mezo burns). Returns null if the repay would land in the trove, else Mezo's revert reason:
/// a used-up nonce, expired deadline or the 1,800 MUSD minimum debt sends the payout to the wallet instead.
export async function autoRepayProblem(client, vault, policy) {
  if (!policy.autoRepay) return 'auto-repay is off'
  if (BigInt(Math.floor(Date.now() / 1000)) > policy.sigDeadline) return 'signature deadline passed'
  try {
    const [upper, lower] = await repayHints(client, policy.holder, policy.cover)
    await client.simulateContract({
      account: vault, address: ADDR.sigs, abi: mezoAbi, functionName: 'repayMUSDWithSignature',
      args: [policy.cover, upper, lower, policy.holder, policy.signature, policy.sigDeadline],
    })
    return null
  } catch (e) {
    // Only a revert means the repay would fail. A timeout or RPC error says nothing about it, and
    // a claim can't be redone: rethrow so the caller retries instead of paying the wallet.
    const revert = e.walk?.((x) => x instanceof ContractFunctionRevertedError)
    if (!revert) throw e
    return revert.reason ?? revert.shortMessage
  }
}

/// Waits for a transaction's receipt. Mezo's public RPC is load-balanced and some of its nodes
/// answer eth_getTransactionReceipt with null for minutes after the transaction is mined; a
/// kept-alive connection can stay pinned to such a node (that is what made viem's
/// waitForTransactionReceipt hang). So poll the RPC, and after a few seconds also ask the
/// explorer, which indexes the same chain, for the status and logs.
export async function waitForReceipt(client, hash, { timeout = 180_000, interval = 1_500 } = {}) {
  const start = Date.now()
  for (; Date.now() < start + timeout; await new Promise((r) => setTimeout(r, interval))) {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
    if (receipt) return receipt
    if (Date.now() - start > 6_000) {
      const fromExplorer = await explorerReceipt(hash).catch(() => null)
      if (fromExplorer) return fromExplorer
    }
  }
  throw new Error(`Mezo has not confirmed ${hash} after ${timeout / 1000} s`)
}

/// The receipt fields Payung reads (status, block, logs), from the Blockscout API. Null while pending.
export async function explorerReceipt(hash) {
  const tx = await fetch(`${EXPLORER_API}/transactions/${hash}`).then((r) => (r.ok ? r.json() : null))
  if (!tx?.block_number || !tx.status) return null
  const { items } = await fetch(`${EXPLORER_API}/transactions/${hash}/logs`).then((r) => r.json())
  return {
    transactionHash: hash,
    blockNumber: BigInt(tx.block_number),
    status: tx.status === 'ok' ? 'success' : 'reverted',
    logs: items.map((l) => ({ address: l.address.hash, topics: l.topics.filter(Boolean), data: l.data, logIndex: l.index, transactionHash: hash })),
  }
}

/// Every `eventName` log a contract emitted since `fromBlock`, decoded. Mezo's RPC caps eth_getLogs
/// at 10,000 blocks (~13 h); the explorer's Etherscan-style getLogs takes the whole range, one topic.
/// ponytail: the explorer returns at most 1,000 logs per call; page by block when one event outgrows it.
export async function explorerLogs(address, abi, eventName, fromBlock) {
  const topic0 = toEventSelector(getAbiItem({ abi, name: eventName }))
  const { result, message } = await fetch(`${EXPLORER_API.replace('/v2', '')}?module=logs&action=getLogs&address=${address}&topic0=${topic0}&fromBlock=${fromBlock}&toBlock=latest`).then((r) => r.json())
  if (!Array.isArray(result)) throw new Error(`explorer getLogs: ${message}`) // "No logs found" still comes with []
  return parseEventLogs({
    abi,
    eventName,
    logs: result.map((l) => ({ address: l.address, topics: l.topics.filter(Boolean), data: l.data, blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex), transactionHash: l.transactionHash, timestamp: Number(l.timeStamp) })),
  })
}

/// Mezo testnet's eth_estimateGas undershoots calls that read the BTC oracle precompile
/// (txs ran out of gas at the estimate). Gas costs ~150 wei there, so use a fixed roomy limit.
export const GAS = 3_000_000n
