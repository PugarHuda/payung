// Mezo Passport's Bitcoin wallets (OrangeKit, the layer under @mezo-org/passport). Each BTC wallet
// drives a Mezo smart account: transactions go through it, signed by the Bitcoin wallet.
// Loaded on demand (it is large), and used without RainbowKit or a wagmi provider tree:
// a wagmi connector is only a factory taking { chains, emitter }.
import './node-shim.js'
import { getOrangeKitUnisatConnector, getOrangeKitOKXConnector, getOrangeKitXverseConnector } from '@mezo-org/orangekit'
import { mezoTestnet } from '../../shared/mezo.js'

const FACTORIES = { unisat: getOrangeKitUnisatConnector, okx: getOrangeKitOKXConnector, xverse: getOrangeKitXverseConnector }

async function connector(id) {
  const c = FACTORIES[id]({ rpcUrl: mezoTestnet.rpcUrls.default.http[0], chainId: mezoTestnet.id })()({ chains: [mezoTestnet], emitter: { emit() {} } })
  await c.setup()
  return c
}

const session = async (c, address) => ({ address, client: await c.getClient({ chainId: mezoTestnet.id }), disconnect: () => c.disconnect() })

/** Connect a Bitcoin wallet; resolves to the Mezo smart-account address and a viem wallet client. */
export async function connectBitcoin(id) {
  const c = await connector(id)
  const { accounts } = await c.connect({ chainId: mezoTestnet.id })
  return session(c, accounts[0])
}

/** The same, without a prompt, if the wallet still lets this site read its account; else null. */
export async function reconnectBitcoin(id) {
  const c = await connector(id)
  if (!(await c.isAuthorized())) return null
  const [address] = await c.getAccounts()
  return session(c, address)
}
