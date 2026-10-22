// POST /api/relay: submits a Mezo Passport account's Bitcoin-signed transaction (see
// shared/relay.js for what it accepts). GET: the relayer's address and gas, for the app and for
// whoever tops it up. Vercel Function; the key is the RELAYER_KEY environment variable.
import { createPublicClient, createWalletClient, http, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mezoTestnet } from '../shared/mezo.js'
import { relay } from '../shared/relay.js'

// The Vercel app calls it from its own origin; the GitHub Pages mirror and local runs need CORS.
const ORIGINS = /^(https:\/\/payung-ecru\.vercel\.app|https:\/\/pugarhuda\.github\.io|http:\/\/localhost:\d+)$/

function cors(request) {
  const origin = request.headers.get('origin')
  return origin && ORIGINS.test(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', vary: 'origin' }
    : {}
}
const json = (request, body, status = 200) => Response.json(body, { status, headers: cors(request) })

function clients() {
  const key = process.env.RELAYER_KEY
  if (!key) return null
  const transport = http(process.env.MEZO_RPC, { timeout: 60_000 })
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  return { pub: createPublicClient({ chain: mezoTestnet, transport }), wallet: createWalletClient({ account, chain: mezoTestnet, transport }) }
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request) })
}

export async function GET(request) {
  const c = clients()
  if (!c) return json(request, { error: 'relayer not configured (RELAYER_KEY)' }, 503)
  const balance = await c.pub.getBalance({ address: c.wallet.account.address })
  return json(request, { relayer: c.wallet.account.address, balance: formatEther(balance) })
}

export async function POST(request) {
  const c = clients()
  if (!c) return json(request, { error: 'relayer not configured (RELAYER_KEY)' }, 503)
  let req
  try {
    req = await request.json()
  } catch {
    return json(request, { error: 'bad request' }, 400)
  }
  try {
    const transactionHash = await relay(c.pub, c.wallet, req)
    return json(request, { transactionHash })
  } catch (e) {
    return json(request, { error: e.message }, e.status ?? 502)
  }
}
