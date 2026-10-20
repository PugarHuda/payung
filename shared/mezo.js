// Shared by the keeper and the app. Mezo testnet (matsnet) addresses from github.com/mezo-org/musd.
import { defineChain, parseAbi } from 'viem'
import payungAbi from '../payung.abi.json' with { type: 'json' }

export const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  testnet: true,
})

export const ADDR = {
  payung: '0x7F9f315304450d5E78475223374545B8B9b873A0',
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  sigs: '0xD757e3646AF370b15f32EB557F0F8380Df7D639e',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  sortedTroves: '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA',
}

export { payungAbi }

export const mezoAbi = parseAbi([
  'function fetchPrice() view returns (uint256)',
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
    return e.walk?.((x) => x.reason)?.reason ?? e.shortMessage ?? e.message
  }
}

/// Mezo testnet's eth_estimateGas undershoots calls that read the BTC oracle precompile
/// (txs ran out of gas at the estimate). Gas costs ~150 wei there, so use a fixed roomy limit.
export const GAS = 3_000_000n
