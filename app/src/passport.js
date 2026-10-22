// Mezo Passport's Bitcoin wallets (OrangeKit, the layer under @mezo-org/passport). Each BTC wallet
// drives a Mezo smart account: transactions go through it, signed by the Bitcoin wallet.
// Loaded on demand (it is large), and used without RainbowKit or a wagmi provider tree:
// a wagmi connector is only a factory taking { chains, emitter }.
// ponytail: no reconnect on reload for BTC wallets; add with connector.isAuthorized() if asked for.
import './node-shim.js'
import { getOrangeKitUnisatConnector, getOrangeKitOKXConnector, getOrangeKitXverseConnector } from '@mezo-org/orangekit'
import { mezoTestnet } from '../../shared/mezo.js'

const FACTORIES = { unisat: getOrangeKitUnisatConnector, okx: getOrangeKitOKXConnector, xverse: getOrangeKitXverseConnector }

/** Connect a Bitcoin wallet; resolves to the Mezo smart-account address and a viem wallet client. */
export async function connectBitcoin(id) {
  const rpcUrl = mezoTestnet.rpcUrls.default.http[0]
  const connector = FACTORIES[id]({ rpcUrl, chainId: mezoTestnet.id })()({ chains: [mezoTestnet], emitter: { emit() {} } })
  await connector.setup()
  const { accounts } = await connector.connect({ chainId: mezoTestnet.id })
  return { address: accounts[0], client: await connector.getClient({ chainId: mezoTestnet.id }), disconnect: () => connector.disconnect() }
}
