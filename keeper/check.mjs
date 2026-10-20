// Read-only: is each auto-repay policy still armed? Usage: node check.mjs [vault]
import { createPublicClient, http } from 'viem'
import { mezoTestnet, ADDR, payungAbi, autoRepayProblem } from '../shared/mezo.js'

const pub = createPublicClient({ chain: mezoTestnet, transport: http() })
const vault = process.argv[2] ?? ADDR.payung
const count = await pub.readContract({ address: vault, abi: payungAbi, functionName: 'policyCount' })
for (let id = 0n; id < count; id++) {
  const p = await pub.readContract({ address: vault, abi: payungAbi, functionName: 'policy', args: [id] })
  console.log(`#${id} ${p.holder} cover ${p.cover / 10n ** 18n}: ${(await autoRepayProblem(pub, vault, p)) ?? 'armed: payout repays the trove'}`)
}
