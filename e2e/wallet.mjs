// A real EIP-1193 wallet for Playwright: the page gets a provider whose requests are answered in
// Node by a viem account, which signs locally and broadcasts to Mezo testnet. Starts on Ethereum
// mainnet with Mezo unknown, like a fresh MetaMask, so the app's add/switch-chain path runs too.
import { createPublicClient, createWalletClient, http, numberToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet } from '../shared/mezo.js'

export async function installWallet(page, key, rpc, { rejectConnect = false, rejectSwitch = false } = {}) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: mezoTestnet, transport: http(rpc, { timeout: 60_000 }) })
  const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http(rpc, { timeout: 60_000 }) })
  const state = { chainId: 1, mezoAdded: false, requests: [], watched: [] }

  await page.exposeFunction('__walletRpc', async (method, params = []) => {
    state.requests.push(method)
    switch (method) {
      case 'eth_requestAccounts':
        if (rejectConnect) throw { code: 4001, message: 'User rejected the request.' }
        return [account.address]
      case 'eth_accounts':
        return rejectConnect ? [] : [account.address]
      case 'wallet_watchAsset': // EIP-747, as MetaMask takes it (params is an object, not an array)
        state.watched.push(params.options ?? params[0]?.options)
        return true
      case 'eth_chainId':
        return numberToHex(state.chainId)
      case 'wallet_addEthereumChain':
        state.mezoAdded = true
        state.chainId = Number(params[0].chainId)
        return null
      case 'wallet_switchEthereumChain': {
        const id = Number(params[0].chainId)
        if (rejectSwitch) throw { code: 4001, message: 'User rejected the request.' }
        if (id === mezoTestnet.id && !state.mezoAdded) throw { code: 4902, message: 'Unrecognized chain ID' }
        state.chainId = id
        return null
      }
      case 'eth_signTypedData_v4': {
        const { domain, types, primaryType, message } = JSON.parse(params[1])
        delete types.EIP712Domain
        return account.signTypedData({ domain, types, primaryType, message })
      }
      case 'personal_sign': // [hex message, address], as MetaMask takes it
        return account.signMessage({ message: { raw: params[0] } })
      case 'eth_sendTransaction': {
        const tx = params[0]
        return wallet.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas ? BigInt(tx.gas) : undefined, value: tx.value ? BigInt(tx.value) : 0n })
      }
      default:
        return pub.request({ method, params })
    }
  })

  await page.addInitScript(() => {
    const listeners = {}
    const provider = {
      isPayungE2E: true,
      async request({ method, params }) {
        try {
          return await window.__walletRpc(method, params)
        } catch (e) {
          const err = new Error(e?.message ?? String(e))
          err.code = e?.code ?? -32603
          throw err
        }
      },
      on: (ev, fn) => (listeners[ev] ??= []).push(fn),
      removeListener: (ev, fn) => (listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)),
    }
    window.__emitWallet = (ev, value) => (listeners[ev] ?? []).forEach((f) => f(value))
    const detail = Object.freeze({ info: { uuid: 'e2e-wallet', name: 'E2E Wallet', icon: '', rdns: 'dev.payung.e2e' }, provider })
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  })
  return { account, pub, wallet, state }
}
