// Mezo Passport's Bitcoin wallets (OrangeKit, the layer under @mezo-org/passport). Each BTC wallet
// drives a Mezo smart account (an OrangeKit Safe): transactions are signed by the Bitcoin wallet.
// OrangeKit's connector handles the wallet; transactions go through Payung's relayer (api/relay.js),
// because Mezo's Passport relay refuses other sites. Loaded on demand (it is large), without
// RainbowKit or a wagmi provider tree: a wagmi connector is only a factory taking { chains, emitter }.
import './node-shim.js'
import { getOrangeKitUnisatConnector, getOrangeKitOKXConnector, getOrangeKitXverseConnector } from '@mezo-org/orangekit'
import { OrangeKitSmartAccount } from '@mezo-org/orangekit-smart-account'
import { createWalletClient, decodeFunctionData, http, parseAbi } from 'viem'
import { toAccount } from 'viem/accounts'
import { mezoTestnet } from '../../shared/mezo.js'

const FACTORIES = { unisat: getOrangeKitUnisatConnector, okx: getOrangeKitOKXConnector, xverse: getOrangeKitXverseConnector }
const RPC = mezoTestnet.rpcUrls.default.http[0]
// Vercel serves the relayer next to the app (production, previews, any custom domain); the GitHub
// Pages mirror and local runs call the production one, which allows them through CORS.
const HOSTED_ELSEWHERE = location.hostname === 'pugarhuda.github.io' || location.hostname === 'localhost'
export const RELAY = import.meta.env.VITE_RELAY_URL ?? (HOSTED_ELSEWHERE ? 'https://payung-ecru.vercel.app/api/relay' : '/api/relay')
const INJECTED = { unisat: () => window.unisat, okx: () => window.okxwallet?.bitcoin, xverse: () => undefined }

async function connector(id) {
  const c = FACTORIES[id]({ rpcUrl: RPC, chainId: mezoTestnet.id })()({ chains: [mezoTestnet], emitter: { emit() {} } })
  await c.setup()
  return c
}

/** The account's viem client: reads over Mezo's RPC, writes as Bitcoin-signed Safe transactions. */
async function session(id, c, address) {
  const btc = c.getBitcoinProvider()
  const [btcAddress, publicKey] = await Promise.all([btc.getAddress(), btc.getPublicKey()])
  let owner // the Bitcoin owner as OrangeKit's factory knows it; the relayer checks the Safe against it
  const sender = {
    async sendTransaction({ to, data }) {
      const res = await fetch(RELAY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, data, owner }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.transactionHash) throw new Error(`Payung's relayer refused the transaction: ${body.error ?? `HTTP ${res.status}`}`)
      return { hash: body.transactionHash }
    },
  }
  const smart = await OrangeKitSmartAccount.init(mezoTestnet.id, RPC, sender)
  const deploy = await smart.populateSafeDeploymentTransaction(btcAddress, publicKey)
  owner = decodeFunctionData({ abi: parseAbi(['function deploySafe(bytes20)']), data: deploy.data }).args[0]
  const account = toAccount({
    address,
    signMessage: ({ message }) => btc.signMessage(typeof message === 'string' ? message : message.raw.toString()),
    signTransaction: () => Promise.reject(new Error('Passport accounts send Safe transactions, not raw ones')),
    signTypedData: () => Promise.reject(new Error("Bitcoin wallets can't sign typed data")),
  })
  const client = createWalletClient({ chain: mezoTestnet, account, transport: http(RPC) }).extend(() => ({
    sendTransaction: ({ to, value, data }) => smart.sendTransaction(to, (value ?? 0n).toString(), data ?? '0x', btcAddress, publicKey, (m) => btc.signMessage(m)),
  }))
  // Unisat and OKX announce account switches; calls `fn` once on a switch, returns an unsubscribe.
  const watch = (fn) => {
    const injected = INJECTED[id]?.()
    const on = () => fn()
    injected?.on?.('accountsChanged', on)
    return () => injected?.removeListener?.('accountsChanged', on)
  }
  return { address, client, watch, disconnect: () => c.disconnect() }
}

/** Connect a Bitcoin wallet; resolves to the Mezo smart-account address and a viem wallet client. */
export async function connectBitcoin(id) {
  const c = await connector(id)
  const { accounts } = await c.connect({ chainId: mezoTestnet.id })
  return session(id, c, accounts[0])
}

/** The same, without a prompt, if the wallet still lets this site read its account; else null. */
export async function reconnectBitcoin(id) {
  const c = await connector(id)
  if (!(await c.isAuthorized())) return null
  const [address] = await c.getAccounts()
  return session(id, c, address)
}
