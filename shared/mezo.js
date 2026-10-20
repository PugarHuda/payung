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
  payung: '0x5eFFEe5B8b817E7A1B785C1a97487C6394cb6b87',
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
])

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

/// Mezo testnet's eth_estimateGas undershoots calls that read the BTC oracle precompile
/// (txs ran out of gas at the estimate). Gas costs ~150 wei there, so use a fixed roomy limit.
export const GAS = 3_000_000n
