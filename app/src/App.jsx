import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseUnits, isAddress, parseEventLogs, encodeFunctionData } from 'viem'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, poolsAbi, btcForMusd, repayTypedData, repayHints, autoRepayProblem, redemptionQueue, redemptionHistory, waitForReceipt, explorerLogs, GAS } from '../../shared/mezo.js'
import { touchChance, touchRate } from '../../shared/odds.js'
import { NTFY, KEEPERS, notify, readAlerts, topicFor } from '../../shared/notify.js'
import './App.css'

// ?vault= override is dev-only: in a shared build a link could aim MUSD approvals at any contract.
const override = new URLSearchParams(location.search).get('vault')
const PAYUNG = import.meta.env.DEV && override && isAddress(override) ? override : ADDR.payung
const ZERO = '0x0000000000000000000000000000000000000000'
const WALLET_KEY = 'payung.wallet' // the wallet last connected, to reconnect on reload
const WAD = 10n ** 18n
const STEP = 1000n * WAD
const MIN_COVER = 10n * WAD
const MCR = 110n // liquidation at 110% collateral ratio
const CCR = 150n // in recovery mode (system ratio under 150%) loans under 150% can be liquidated
const TARGET_CR = 150n // cover sized to lift the trove back to 150% at the strike
const WEEK = 604800n
const MAX_WEEKS = 4 // the contract sells cover to this week's expiry or up to 3 weeks after
const MAX_STRIKES = 32 // per expiry, as in the contract
const SLIPPAGE = 103n // accept a premium up to 3% above the quote: near strikes move ~25x as much as BTC
const ALERT_BAND = 103n // notify when BTC is within 3% of an active strike
const EXPLORER = mezoTestnet.blockExplorers.default.url
// VITE_MEZO_RPC points the app at another node, e.g. the anvil fork the touch e2e test runs.
// batch.multicall: reads issued together go to Mezo as one Multicall3 eth_call instead of dozens.
const pub = createPublicClient({ chain: mezoTestnet, batch: { multicall: true }, transport: http(import.meta.env.VITE_MEZO_RPC, { timeout: 30_000 }) }) // slow RPCs exist; viem defaults to 10 s

// Archive reads of Mezo's BTC oracle, JSON-RPC batched (Mezo's RPC takes 100 calls per request).
const archive = createPublicClient({ chain: mezoTestnet, transport: http(import.meta.env.VITE_MEZO_RPC, { batch: { batchSize: 100 }, timeout: 30_000 }) })
const HISTORY_DAYS = 30
const BTC_POINTS = 360 // one every 2 hours
/** BTC on Mezo's oracle every ~2 hours for 30 days, oldest first: [{ t, p }]. */
async function btcHistory() {
  // Block time varies (4.35-4.9 s), so find the block 30 days back: guess, then correct once.
  const span = HISTORY_DAYS * 86400
  const head = await archive.getBlock()
  let from = head.number - BigInt(Math.round(span / 4.5))
  const guess = await archive.getBlock({ blockNumber: from })
  from = head.number - BigInt(Math.round((span * Number(head.number - from)) / Number(head.timestamp - guess.timestamp)))
  const step = (head.number - from) / BigInt(BTC_POINTS)
  const rounds = await Promise.all(Array.from({ length: BTC_POINTS + 1 }, (_, i) =>
    archive.readContract({ address: ADDR.oracle, abi: mezoAbi, functionName: 'latestRoundData', blockNumber: head.number - BigInt(BTC_POINTS - i) * step })))
  return rounds.map((r) => ({ t: Number(r[3]), p: Number(formatUnits(r[1], 18)) }))
}

const usd = (v, d = 0) => (v == null ? '…' : '$' + Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d }))
const musd = (v, d = 2) => (v == null ? '…' : Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d }) + ' MUSD')
const pct = (wad, d = 1) => (wad == null ? '…' : Number(formatUnits(wad, 16)).toFixed(d) + '%')
const date = (t) => new Date(Number(t) * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
const roundUp = (v, step) => ((v + step - 1n) / step) * step
const nowSec = () => BigInt(Math.floor(Date.now() / 1000))
const ago = (t) => {
  const m = Math.round(Number(nowSec() - t) / 60)
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
const left = (t) => {
  const s = Number(t - nowSec())
  if (s <= 0) return 'ended'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
const ratio = (coll, price, debt) => `${((Number(coll) * Number(price)) / Number(debt) / 1e16).toFixed(0)}%`
const parseAmount = (s) => {
  try {
    return s ? parseUnits(s, 18) : 0n
  } catch {
    return null // not a number
  }
}
/** A renewal link (?strike=75000&cover=500&expiry=1793433600), as written into calendar reminders. */
function linkPrefill() {
  const q = new URLSearchParams(location.search)
  const strike = /^\d+$/.test(q.get('strike') ?? '') ? BigInt(q.get('strike')) * WAD : undefined
  if (!strike || strike % STEP) return undefined
  const cover = /^\d+(\.\d+)?$/.test(q.get('cover') ?? '') ? q.get('cover') : undefined
  const expiry = /^\d+$/.test(q.get('expiry') ?? '') ? BigInt(q.get('expiry')) : undefined
  return { strike, cover, expiry }
}
// ?address=0x… shows any wallet's loan, cover and alerts read-only, with no wallet connected
// (for an advisor, a teammate, or a judge looking at real policies). Nothing can be signed in it.
const watchParam = new URLSearchParams(location.search).get('address')
const WATCH = watchParam && isAddress(watchParam) ? watchParam : undefined
const renewLink = (p) => `${location.origin}${location.pathname}?strike=${p.strike / WAD}&cover=${formatUnits(p.cover, 18)}&expiry=${p.expiry + WEEK}`
const txLink = (hash) => <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a>

const REVERTS = {
  'Payung: premium moved': 'The premium rose while you were confirming (BTC moved). Check the new quote and try again.',
  'Payung: vault capacity': 'The vault cannot back that much cover right now. Lower the cover amount.',
  'Payung: sales closed': 'Cover ending this week stops selling an hour before expiry. Pick a longer cover period.',
  'Payung: strike out of range': 'BTC moved and the strike is no longer 5–30% below the price. Pick the strike again.',
  'Payung: strike above spot': 'BTC fell below that strike while you were confirming. Pick the strike again.',
  'Payung: strike already touched': 'BTC already touched that strike in this cover period, so it no longer sells. Pick another strike or period.',
  'Payung: too many strikes': 'This cover period already sells its maximum of 32 strikes. Pick a strike someone already bought, or another period.',
  'Payung: cover too small': 'The smallest cover is 10 MUSD.',
  'Payung: epoch over': 'That cover period has ended.',
  // Races with the keeper or another user: someone got there first.
  'Payung: nothing to trigger': 'Someone else triggered that strike first.',
  'Payung: not touched': 'BTC moved back above the strike before your trigger landed.',
  'Payung: already paid': 'This cover has already been paid out (the keeper got there first).',
  'PriceFeed: Oracle is stale.': 'The Mezo price feed is stale right now. Try again in a minute.',
  'Payung: not holder': 'Only the wallet that bought this cover can change it. Switch back to that account.',
  'Payung: more gas': 'The payout needs more gas. Try again.',
  'Payung: repay failed': "Mezo didn't accept the repay into the loan. Only the cover's owner can take the payout to their wallet in the first 6 hours.",
  'Payung: new strike needs 100 MUSD': 'Nobody has bought this strike yet in this period, and opening a new one takes at least 100 MUSD of cover.',
}
// What Payung's relayer for Bitcoin wallets answers (shared/relay.js), in plain words.
const RELAY_REFUSALS = [
  [/too many transactions/, 'Too many transactions from this connection in a minute. Wait a moment and try again.'],
  [/Safe not deployed yet/, 'Your Bitcoin wallet\'s Mezo account is still being set up. Try again in a few seconds.'],
  [/GS0(2[0-9]|1[0-9])|signature/i, 'Your Bitcoin wallet\'s signature didn\'t match its Mezo account (did you switch accounts in the wallet?). Reconnect and try again.'],
  [/would revert/, 'Mezo would reject this transaction right now (BTC or the vault may have moved). Check the numbers and try again.'],
  [/not configured|could not submit/, 'Payung\'s relayer for Bitcoin wallets is unavailable right now. Try again in a minute, or use an EVM wallet.'],
]
// OpenZeppelin custom errors carry no reason string, only a name.
const CUSTOM = {
  ERC4626ExceededMaxWithdraw: 'BTC moved and less is free to withdraw now. Lower the amount or press Max again.',
  ERC4626ExceededMaxRedeem: 'BTC moved and less is free to withdraw now. Press Max again.',
  EnforcedPause: 'The vault owner has paused new cover.',
  ERC20InsufficientAllowance: 'The MUSD approval is too small. Try again to approve the new amount.',
  ERC20InsufficientBalance: 'Your wallet holds too little MUSD for this.',
}
function explain(e) {
  if (e?.walk?.((x) => x.code === 4001) || /rejected|denied/i.test(e?.message ?? '')) return 'You cancelled the request in your wallet.'
  const relayed = e?.message?.match(/^Payung's relayer refused the transaction: (.*)$/)?.[1]
  if (relayed) return RELAY_REFUSALS.find(([re]) => re.test(relayed))?.[1] ?? `Payung's relayer didn't send it (${relayed}).`
  if (/Not enough native token balance/.test(e?.message ?? '')) return 'Your Mezo Passport account needs a little BTC on Mezo to pay the gas. Send some to it (faucet.test.mezo.org on testnet) and try again.'
  if (e?.walk?.((x) => x.name === 'InsufficientFundsError')) return 'Your wallet has too little BTC to pay the gas. Get testnet BTC from the Mezo faucet (faucet.test.mezo.org) and try again.'
  const reason = e?.walk?.((x) => x.reason)?.reason
  const name = e?.walk?.((x) => x.data?.errorName)?.data?.errorName
  if (CUSTOM[name]) return CUSTOM[name]
  return REVERTS[reason] ?? reason ?? e?.shortMessage ?? e?.message ?? String(e)
}

/** A browser alert, through the service worker when there is one (Android Chrome refuses
 *  `new Notification`); an alert must never take the page down. */
async function show(body) {
  try {
    const sw = await navigator.serviceWorker?.getRegistration()
    if (sw) return await sw.showNotification('Payung', { body })
    new Notification('Payung', { body })
  } catch (e) {
    console.warn('alert not shown', e)
  }
}

/** EIP-6963: every injected wallet announces itself; fall back to window.ethereum. */
function useWallets() {
  const [list, setList] = useState([])
  useEffect(() => {
    const onAnnounce = (e) => setList((l) => (l.some((w) => w.info.uuid === e.detail.info.uuid) ? l : [...l, e.detail]))
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }, [])
  if (list.length) return list
  return window.ethereum ? [{ info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum }] : []
}

/** Bitcoin wallets Mezo Passport supports, if their extension is installed. */
const btcWallets = () => [
  window.unisat && { id: 'unisat', name: 'Unisat' },
  window.okxwallet?.bitcoin && { id: 'okx', name: 'OKX (Bitcoin)' },
  window.XverseProviders?.BitcoinProvider && { id: 'xverse', name: 'Xverse' },
].filter(Boolean)

/** Price at which the trove can be liquidated: 110%, or 150% once the whole system falls into
 *  recovery mode (its ratio scales with price, so recovery starts at price × 150% / TCR). */
function liquidationPrice({ coll, debt }, price, tcr) {
  if (!coll || !debt) return {}
  const at110 = (debt * MCR * 10n ** 16n) / coll
  const at150 = (debt * CCR * 10n ** 16n) / coll
  const recoveryAt = price && tcr ? (price * CCR * 10n ** 16n) / tcr : 0n
  const viaRecovery = recoveryAt > at110
  return { liq: viaRecovery ? (at150 < recoveryAt ? at150 : recoveryAt) : at110, viaRecovery, recoveryAt }
}

export default function App() {
  const wallets = useWallets()
  const [provider, setProvider] = useState()
  const [btcWallet, setBtcWallet] = useState() // a Mezo Passport connection: { client, disconnect }
  const [picking, setPicking] = useState(false)
  const [account, setAccount] = useState(WATCH)
  const [chainId, setChainId] = useState()
  const [tab, setTab] = useState('protect')
  const [chain, setChain] = useState({})
  const [me, setMe] = useState({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState()
  const [offline, setOffline] = useState(false) // the last refresh could not reach Mezo's RPC
  const [prefill, setPrefill] = useState(linkPrefill)
  const [btc, setBtc] = useState() // 30 days of BTC on Mezo's oracle; null if the archive reads fail
  useEffect(() => {
    btcHistory().then(setBtc, () => setBtc(null))
  }, [])
  const [alerts, setAlerts] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted')
  // Android shows page alerts only through a service worker (public/sw.js); only alert users get one.
  useEffect(() => {
    if (alerts) navigator.serviceWorker?.register('sw.js').catch((e) => console.warn('service worker', e))
  }, [alerts])
  const alerted = useRef() // alert keys already shown, per account, kept across reloads

  const wallet = useMemo(() => btcWallet?.client ?? (provider ? createWalletClient({ chain: mezoTestnet, transport: custom(provider) }) : null), [provider, btcWallet])
  const watching = !!account && !wallet
  const wrongChain = !!provider && !!account && chainId !== mezoTestnet.id
  const readP = useCallback((functionName, args = []) => pub.readContract({ address: PAYUNG, abi: payungAbi, functionName, args }), [])
  const readM = useCallback((address, functionName, args = []) => pub.readContract({ address, abi: mezoAbi, functionName, args }), [])

  useEffect(() => {
    if (!provider?.on) return
    const onAccounts = (a) => {
      setAccount(a[0])
      setMe({})
    }
    const onChain = (c) => setChainId(Number(c))
    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider])

  // One refresh at a time: on a slow RPC the 15 s timer would otherwise stack them up.
  // A refresh asked for mid-flight (e.g. right after a transaction) runs once the current one ends.
  const inflight = useRef(null)
  const again = useRef(false)
  // A load started for the previous account must not write its data under the new one.
  const acct = useRef(account)
  acct.current = account
  const latest = useRef()
  const refresh = useCallback(() => {
    if (inflight.current) {
      again.current = true
      return inflight.current
    }
    inflight.current = load().finally(() => {
      inflight.current = null
      if (again.current) {
        again.current = false
        // The newest refresh (the account may have changed). Not returned: awaiting callers must not
        // wait on an endless chain; caught, or a fetch cut off by a reload is an unhandled rejection.
        latest.current().catch((e) => console.warn('refresh failed', e))
      }
    })
    return inflight.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])
  latest.current = refresh

  const load = async () => {
    const [price, round] = await Promise.all([readM(ADDR.priceFeed, 'fetchPrice').catch(() => null), readM(ADDR.oracle, 'latestRoundData').catch(() => null)])
    const [nav, free, capacity, locked, expiry, supply, vol, maxUtil, balance, owed, recovery, tcr, observedAt, paused] = await Promise.all([
      readP('totalAssets'), readP('freeLiquidity'), readP('coverCapacity'), readP('totalLocked'),
      readP('currentExpiry'), readP('totalSupply'), readP('volatility'), readP('maxUtilization'),
      readM(ADDR.musd, 'balanceOf', [PAYUNG]), readP('totalOwed'),
      price ? readM(ADDR.troveManager, 'checkRecoveryMode', [price]) : null,
      price ? readM(ADDR.troveManager, 'getTCR', [price]) : null,
      readP('lastObservedAt'), readP('paused'),
    ])
    // Cover needed to open a strike nobody bought yet in a period; vaults deployed before the rule have no getter.
    const minNewStrike = await readP('MIN_NEW_STRIKE_COVER').catch(() => 0n)
    // Every strike sold in every live expiry (multicall makes this one round trip per step).
    const expiries = Array.from({ length: MAX_WEEKS }, (_, w) => expiry + BigInt(w) * WEEK)
    const lists = await Promise.all(expiries.map((e) => readP('strikeList', [e])))
    const strikes = await Promise.all(expiries.flatMap((e, i) => lists[i].map(async (strike) => {
      const [cover, triggered] = await readP('strikes', [e, strike])
      return { expiry: e, strike, cover, triggered }
    })))
    // Strikes BTC is at or under that nobody has triggered yet: anyone can trigger them and earn the reward.
    const touchable = await Promise.all(strikes.filter((s) => price && price <= s.strike && !s.triggered)
      .map(async (s) => ({ ...s, reward: await readP('triggerReward', [s.cover]) })))
    const full = new Set(expiries.filter((_, i) => lists[i].length >= MAX_STRIKES))
    setChain({ price, priceAt: round?.[3], minNewStrike, nav, free, capacity, locked, expiry, supply, vol, maxUtil, balance, owed, recovery, tcr, observedAt, paused, touchable, strikes, full })
    if (!account) return
    const [debtColl, status, bal, code, shares, ids, btcBal] = await Promise.all([
      readM(ADDR.troveManager, 'getEntireDebtAndColl', [account]),
      readM(ADDR.troveManager, 'getTroveStatus', [account]),
      readM(ADDR.musd, 'balanceOf', [account]),
      pub.getCode({ address: account }),
      readP('balanceOf', [account]),
      readP('policiesOf', [account]),
      pub.getBalance({ address: account }),
    ])
    // The queue walks every sorted trove: slow on a slow RPC, and only an extra line, so it lands
    // on its own instead of holding up the loan, the cover and the Buy button.
    redemptionQueue(pub, account).then((queue) => acct.current === account && setMe((m) => ({ ...m, queue })), () => {})
    const mine = { coll: debtColl[0], debt: debtColl[1] + debtColl[2], hasTrove: status === 1n, bal, shares, btc: btcBal }
    // Mezo checks repay signatures with ECDSA, so smart accounts (e.g. Mezo Passport BTC wallets) can't pre-sign.
    mine.smartAccount = !!code && code !== '0x'
    ;[mine.assets, mine.maxWithdraw] = await Promise.all([readP('convertToAssets', [shares]), readP('maxWithdraw', [account])])
    // Payung v1 (before the claim-griefing fix): its cover still pays out, and its depositors withdraw there.
    if (PAYUNG === ADDR.payung) {
      const readV1 = (functionName, args) => pub.readContract({ address: ADDR.payungV1, abi: payungAbi, functionName, args })
      const [v1Ids, v1Free] = await Promise.all([readV1('policiesOf', [account]), readV1('maxWithdraw', [account])]).catch(() => [[], 0n])
      const v1Live = (await Promise.all(v1Ids.map((id) => readV1('policy', [id])))).filter((p) => !p.claimed && nowSec() < p.expiry).length
      mine.v1 = { live: v1Live, free: v1Free }
    }
    mine.policies = await Promise.all(
      [...ids].reverse().map(async (id) => {
        const p = await readP('policy', [id])
        const [, triggered] = await readP('strikes', [p.expiry, p.strike])
        const live = !p.claimed && (triggered || nowSec() < p.expiry)
        return { id, ...p, triggered, live, problem: live && p.autoRepay ? undefined : null } // undefined: still checking
      }),
    )
    if (acct.current !== account) return
    setMe((m) => ({ ...mine, queue: m.queue })) // keep the last queue until the new one lands
    // The repay dry-run is the slow part; show the table first and fill it in.
    // An RPC failure leaves the row on "checking" (undefined) until the next refresh.
    const problems = await Promise.all(mine.policies.map((p) => (p.problem === undefined ? autoRepayProblem(pub, PAYUNG, p).catch(() => undefined) : null)))
    if (acct.current !== account) return
    setMe((m) => (m.policies !== mine.policies ? m : { ...m, policies: mine.policies.map((p, i) => ({ ...p, problem: problems[i] })) }))
  }

  useEffect(() => {
    const tick = () => refresh().then(() => setOffline(false), (e) => {
      console.warn('refresh failed', e)
      setOffline(true)
    })
    tick()
    const t = setInterval(tick, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  // Browser alerts: BTC close to one of my strikes, or a payout landed.
  useEffect(() => {
    if (!alerts || !chain.price || !me.policies || !account) return
    const key = `payung.alerted.${account.toLowerCase()}`
    if (alerted.current?.account !== account) {
      let seen = null
      try { seen = JSON.parse(localStorage.getItem(key)) } catch {}
      // First time on this account: payouts that already happened are history, not news.
      alerted.current = { account, seen: new Set(seen ?? me.policies.filter((p) => p.claimed).map((p) => `paid-${p.id}`)) }
    }
    const { seen } = alerted.current
    for (const p of me.policies) {
      const near = p.live && !p.triggered && chain.price * 100n <= p.strike * ALERT_BAND
      for (const k of [near && `near-${p.id}`, p.claimed && `paid-${p.id}`].filter(Boolean)) {
        if (seen.has(k)) continue
        seen.add(k)
        // The policy doesn't record where a payout went (the PolicyPaid event does), so don't guess.
        show(k.startsWith('near') ? `BTC is ${usd(chain.price)}, within 3% of your ${usd(p.strike)} umbrella.` : `Your ${musd(p.cover, 0)} cover paid out. My cover shows where the MUSD went.`)
      }
    }
    try { localStorage.setItem(key, JSON.stringify([...seen])) } catch {}
  }, [alerts, chain.price, me.policies, account])

  async function switchChain(client = wallet) {
    try {
      await client.switchChain({ id: mezoTestnet.id })
    } catch (e) {
      // Only a wallet that doesn't know Mezo (4902) gets an "add network" prompt; a "no" stays a no.
      if (!e?.walk?.((x) => x.code === 4902) && !/unrecognized|not been added|unknown chain/i.test(e?.message ?? '')) throw e
      await client.addChain({ chain: mezoTestnet })
    }
    setChainId(await client.getChainId())
  }

  // Reconnect on reload, without a prompt: eth_accounts only answers for a site the wallet already
  // allowed. A view link (?address=) stays a view.
  useEffect(() => {
    if (provider || btcWallet || WATCH) return
    let saved
    try { saved = localStorage.getItem(WALLET_KEY) } catch { return }
    // A Bitcoin wallet through Mezo Passport: back without a prompt if it still lets the site in.
    if (saved?.startsWith('btc:')) {
      import('./passport.js').then(({ reconnectBitcoin }) => reconnectBitcoin(saved.slice(4))).then((s) => {
        if (!s) return
        setBtcWallet({ client: s.client, disconnect: s.disconnect, watch: s.watch })
        setAccount(s.address)
      }, (e) => console.warn('bitcoin wallet reconnect', e))
      return
    }
    const w = wallets.find((x) => (x.info.rdns ?? x.info.uuid) === saved)
    w?.provider.request({ method: 'eth_accounts' }).then(async ([addr]) => {
      if (!addr) return
      setProvider(w.provider)
      setAccount(addr)
      setChainId(Number(await w.provider.request({ method: 'eth_chainId' })))
    }, () => {})
  }, [wallets, provider, btcWallet])

  function disconnect() {
    try { localStorage.removeItem(WALLET_KEY) } catch {}
    btcWallet?.disconnect().catch(() => {})
    setBtcWallet(undefined)
    setProvider(undefined)
    setAccount(undefined)
    setMe({})
  }

  async function connectWith(w) {
    setPicking(false)
    try {
      const client = createWalletClient({ chain: mezoTestnet, transport: custom(w.provider) })
      const [addr] = await client.requestAddresses()
      try { localStorage.setItem(WALLET_KEY, w.info.rdns ?? w.info.uuid) } catch {}
      setProvider(w.provider)
      setAccount(addr)
      setChainId(await client.getChainId())
      await switchChain(client)
    } catch (e) {
      setNotice({ kind: 'error', text: explain(e) })
    }
  }

  async function connectBitcoin(id) {
    setPicking(false)
    try {
      const { connectBitcoin } = await import('./passport.js')
      const { address, client, disconnect, watch } = await connectBitcoin(id)
      try { localStorage.setItem(WALLET_KEY, `btc:${id}`) } catch {}
      setProvider(undefined)
      setBtcWallet({ client, disconnect, watch })
      setAccount(address)
      setMe({})
    } catch (e) {
      setNotice({ kind: 'error', text: explain(e) })
    }
  }

  // A Bitcoin wallet that switches accounts would sign for another Mezo account: start over.
  useEffect(() => btcWallet?.watch?.(() => {
    disconnect()
    setNotice({ kind: 'error', text: 'Your Bitcoin wallet switched accounts. Connect again to use the new one.' })
  }), [btcWallet]) // eslint-disable-line react-hooks/exhaustive-deps

  // EIP-747: ask the wallet to list a token, so pyMUSD and MUSD show up next to the user's BTC.
  async function addToken(address, symbol, decimals) {
    try {
      const added = await wallet.watchAsset({ type: 'ERC20', options: { address, symbol, decimals, image: new URL('favicon.svg', location.href).href } })
      setNotice(added ? { kind: 'ok', text: `${symbol} is now listed in your wallet.` } : { kind: 'error', text: `Your wallet didn't add ${symbol}.` })
    } catch (e) {
      setNotice({ kind: 'error', text: explain(e) })
    }
  }

  function connect() {
    const btc = btcWallets().length
    if (!wallets.length && !btc) return setNotice({ kind: 'error', text: 'No browser wallet found. Install MetaMask or another EVM wallet, or a Bitcoin wallet (Unisat, OKX, Xverse), then reload.' })
    if (wallets.length === 1 && !btc) return connectWith(wallets[0])
    setPicking(true)
  }

  async function enableAlerts() {
    const p = await Notification.requestPermission()
    setAlerts(p === 'granted')
    if (p !== 'granted') setNotice({ kind: 'error', text: 'Notifications are blocked for this site. Allow them in your browser settings.' })
  }

  async function run(label, fn) {
    setBusy(label)
    setNotice()
    try {
      const { text, hash } = await fn()
      setNotice({ kind: 'ok', text, hash })
      refresh().catch((e) => console.warn('refresh failed', e))
    } catch (e) {
      console.warn(`${label} failed`, e) // the plain-words notice below hides the details
      setNotice({ kind: 'error', text: explain(e) })
    } finally {
      setBusy('')
    }
  }

  async function write(address, abi, functionName, args) {
    const req = { account, address, abi, functionName, args }
    await pub.simulateContract(req) // a revert reason now beats a failed transaction later
    // A Mezo Passport client sends through its smart account (signed by the Bitcoin wallet) only via
    // its own sendTransaction; writeContract with an address account would ask Mezo's node to sign.
    const hash = btcWallet
      ? await wallet.sendTransaction({ to: address, data: encodeFunctionData({ abi, functionName, args }) }).catch((e) => {
        // Sent through Payung's relayer (api/relay.js); the browser says only "Failed to fetch" when it can't reach it.
        if (e instanceof TypeError) throw new Error("Payung's relayer for Bitcoin wallets can't be reached right now, so nothing was sent. Try again in a minute.")
        throw e
      })
      : await wallet.writeContract({ ...req, gas: GAS })
    if (hash === '0x') throw new Error("Mezo Passport's relay did not accept the transaction. Try again.") // relay answered without a hash
    setNotice({ kind: 'info', text: 'Sent. Waiting for Mezo to confirm…', hash })
    const r = await waitForReceipt(pub, hash).catch(() => {
      throw new Error(`Sent, but Mezo has not confirmed it after 3 minutes. Check ${EXPLORER}/tx/${hash}`)
    })
    if (r.status !== 'success') throw new Error(`Transaction failed: ${EXPLORER}/tx/${hash}`)
    return hash
  }

  async function ensureAllowance(amount) {
    const allowance = await readM(ADDR.musd, 'allowance', [account, PAYUNG])
    if (allowance < amount) await write(ADDR.musd, mezoAbi, 'approve', [PAYUNG, amount])
  }

  async function signRepay(amount, deadline) {
    const nonce = await readM(ADDR.sigs, 'getNonce', [account])
    return wallet.signTypedData({ account, ...repayTypedData({ amount, borrower: account, nonce, deadline }) })
  }

  // A Passport account is a smart account even before its first transaction deploys it.
  const meSeen = useMemo(() => (btcWallet ? { ...me, smartAccount: true } : me), [me, btcWallet])
  const ctx = { chain, me: meSeen, account, busy, run, write, ensureAllowance, signRepay, readP, connect, addToken: btcWallet ? undefined : addToken, canWrite: !!wallet && !!account && !wrongChain, watching }

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="./">
          <Umbrella /> Payung
        </a>
        <nav aria-label="Sections">
          {[['protect', 'Protect my loan'], ['underwrite', 'Earn by underwriting'], ['policies', 'My cover']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'tab on' : 'tab'} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        {account && !watching ? (
          <span className="acct" title={account}>
            {account.slice(0, 6)}…{account.slice(-4)} <button className="tab" onClick={disconnect}>Disconnect</button>
          </span>
        ) : <button className="primary" onClick={connect}>Connect wallet</button>}
      </header>

      {picking && (
        <div className="banner picker" role="dialog" aria-label="Choose a wallet" onKeyDown={(e) => e.key === 'Escape' && setPicking(false)}>
          <span>Choose a wallet:</span>
          {wallets.map((w) => (
            <button key={w.info.uuid} autoFocus={w === wallets[0]} onClick={() => connectWith(w)}>
              {w.info.icon && <img src={w.info.icon} alt="" width="18" height="18" />} {w.info.name}
            </button>
          ))}
          {btcWallets().map((w, i) => (
            <button key={w.id} autoFocus={!wallets.length && i === 0} onClick={() => connectBitcoin(w.id)}>{w.name} <small>via Mezo Passport</small></button>
          ))}
          <button className="tab" onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {(me.v1?.live > 0 || me.v1?.free > 0n) && (
        <p className="banner info">
          This wallet also has {me.v1.live > 0 && `${me.v1.live} live ${me.v1.live === 1 ? 'policy' : 'policies'}`}{me.v1.live > 0 && me.v1.free > 0n && ' and '}{me.v1.free > 0n && `${musd(me.v1.free)} to withdraw`} in Payung v1 (<a href={`${EXPLORER}/address/${ADDR.payungV1}`} target="_blank" rel="noreferrer">{ADDR.payungV1.slice(0, 6)}…{ADDR.payungV1.slice(-4)}</a>), the vault before the claim-griefing fix. The keeper still pays v1 cover out.{' '}
          {me.v1.free > 0n && !watching && <button className="small" disabled={!ctx.canWrite || !!busy} onClick={() => run('v1', async () => {
            const hash = await write(ADDR.payungV1, payungAbi, 'withdraw', [me.v1.free, account, account])
            return { hash, text: `Withdrew ${musd(me.v1.free)} from Payung v1.` }
          })}>{busy === 'v1' ? 'Withdrawing…' : 'Withdraw it'}</button>}
        </p>
      )}
      {watching && <p className="banner info" role="status">Viewing {account.slice(0, 6)}…{account.slice(-4)} read-only. Connect a wallet to buy, deposit or pay out.</p>}
      {PAYUNG !== ADDR.payung && <p className="banner error">Dev override: using vault {PAYUNG}, not the published Payung vault.</p>}
      {wrongChain && (
        <p className="banner error">
          Your wallet is on another network. <button className="small" onClick={() => switchChain().catch((e) => setNotice({ kind: 'error', text: explain(e) }))}>Switch to Mezo testnet</button>
        </p>
      )}
      {offline && <p className="banner error" role="alert">Can't reach Mezo's RPC ({new URL(mezoTestnet.rpcUrls.default.http[0]).host}) right now, so the numbers below may be missing or out of date. Retrying every 15 seconds.</p>}
      {chain.price === null && <p className="banner error">The Mezo price feed is not answering right now, so new cover and deposits are on hold. Withdrawals, triggers and payouts still work.</p>}
      {chain.paused && <p className="banner error">The vault owner has paused new cover. Existing cover, triggers, payouts, deposits and withdrawals keep working.</p>}
      {chain.recovery && <p className="banner error">Mezo is in recovery mode: the system collateral ratio is {pct(chain.tcr, 0)}, under 150%. Loans under 150% can be liquidated.</p>}
      {notice && <p className={`banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text} {notice.hash && txLink(notice.hash)}</p>}

      {tab === 'protect' && <Protect key={`${account}-${prefill?.strike}-${prefill?.expiry}`} {...ctx} prefill={prefill} btc={btc} />}
      {tab === 'underwrite' && <Underwrite {...ctx} />}
      {tab === 'policies' && <Policies {...ctx} signer={btcWallet ? { bitcoin: true, signMessage: ({ message }) => wallet.account.signMessage({ message }) } : { signMessage: ({ message }) => wallet.signMessage({ account, message }) }} alerts={alerts} enableAlerts={enableAlerts} renew={(p) => {
        setPrefill({ strike: p.strike, cover: formatUnits(p.cover, 18), expiry: p.expiry + WEEK })
        setTab('protect')
      }} />}

      <Horizon />
      <footer>
        Mezo testnet · settles on Mezo's MUSD price feed · <a href={`${EXPLORER}/address/${PAYUNG}`} target="_blank" rel="noreferrer">vault contract</a> · <a href="https://github.com/PugarHuda/payung" target="_blank" rel="noreferrer">source</a>
      </footer>
    </div>
  )
}

function Protect({ chain, me, account, busy, run, write, ensureAllowance, signRepay, readP, connect, canWrite, watching, prefill, btc }) {
  const { price, capacity, vol, tcr } = chain
  const [weeks, setWeeks] = useState(1)
  const [moved, setMoved] = useState() // a renewal's old strike, when today's band no longer allows it
  const expiry = chain.expiry ? chain.expiry + BigInt(weeks - 1) * WEEK : undefined
  const { liq, viaRecovery, recoveryAt } = me.hasTrove ? liquidationPrice(me, price, tcr) : {}
  const minStrike = price ? roundUp((price * 70n) / 100n, STEP) : null
  const maxStrike = price ? ((price * 95n) / 100n / STEP) * STEP : null
  const salesOpen = !!expiry && nowSec() + 3600n < expiry

  const [strike, setStrike] = useState()
  const [cover, setCover] = useState('')
  const [wantRepay, setAutoRepay] = useState(true)
  const [lastQuote, setQuote] = useState()
  const [redemptions, setRedemptions] = useState() // Mezo's whole redemption history; null if the explorer is down

  useEffect(() => {
    if (me.hasTrove) redemptionHistory().then(setRedemptions, () => setRedemptions(null))
  }, [me.hasTrove])
  const q = me.hasTrove && me.queue && me.queue.ahead < me.queue.total ? me.queue : null
  const largest = redemptions?.reduce((m, r) => (r.amount > m ? r.amount : m), 0n)
  const reaching = q && redemptions?.filter((r) => r.amount > q.debtAhead).length

  // Default: umbrella opens a little above the liquidation line, cover lifts the trove to 150%.
  // A renewal (Renew button or a calendar link) starts from the old policy's strike, cover and next week.
  useEffect(() => {
    if (strike || !price || !chain.expiry || capacity == null || (account && me.hasTrove === undefined)) return
    let s = prefill?.strike ?? (liq ? roundUp((liq * 108n) / 100n, STEP) : ((price * 90n) / 100n / STEP) * STEP)
    if (s < minStrike) s = minStrike
    if (s > maxStrike) s = maxStrike
    setStrike(s)
    if (prefill?.strike && s !== prefill.strike) setMoved(prefill.strike)
    // On the week's last day, this week's cover would last hours: start from two weeks instead.
    const w = prefill?.expiry ? Number((prefill.expiry - chain.expiry) / WEEK) + 1 : Number(chain.expiry) - Date.now() / 1000 < 86400 ? 2 : 1
    if (w >= 1 && w <= MAX_WEEKS) setWeeks(w)
    if (prefill?.cover) setCover(prefill.cover)
    else if (me.hasTrove) {
      const need = me.debt - (me.coll * s * 100n) / TARGET_CR / WAD
      setCover((c) => c || (need > MIN_COVER ? (roundUp(need, MIN_COVER) / WAD).toString() : '100')) // typed before the data loaded: keep it
    } else setCover((c) => c || String(capacity >= 100n * WAD || capacity < MIN_COVER ? 100n : capacity / MIN_COVER * 10n)) // no loan: a sample amount the vault can back
  }, [price, liq, me, account, strike, minStrike, maxStrike, capacity, prefill, chain.expiry])

  // Smart accounts can't sign Mezo's ECDSA repay, and with no loan there is nothing to repay.
  const autoRepay = wantRepay && !me.smartAccount && me.hasTrove !== false
  const coverWei = parseAmount(cover)
  const coverError = coverWei === null ? 'Enter a number, like 500.' : coverWei > 0n && coverWei < MIN_COVER ? 'The smallest cover is 10 MUSD.' : null

  useEffect(() => {
    if (!strike || !coverWei || coverWei < MIN_COVER || PAYUNG === ZERO) return setQuote()
    if (!expiry) return
    // Requests race on a slow RPC: only the answer for the current inputs may land.
    let current = true
    readP('quote', [expiry, strike, coverWei]).then(([premium, distance]) => current && setQuote({ premium, distance, expiry, strike, cover: coverWei }), () => current && setQuote())
    return () => { current = false }
  }, [expiry, strike, coverWei, readP, price, vol]) // vol: a keeper sample reprices without moving BTC

  // Until the quote for the inputs on screen arrives, there is none (no buying on an older one).
  const quote = lastQuote && lastQuote.expiry === expiry && lastQuote.strike === strike && lastQuote.cover === coverWei ? lastQuote : undefined
  const tooBig = capacity != null && coverWei > capacity
  const expiring = (chain.strikes ?? []).filter((s) => s.expiry === chain.expiry && !s.triggered).reduce((sum, s) => sum + s.cover, 0n)
  // The contract refuses a strike BTC already touched this period, and a 33rd new strike in one period.
  const sold = chain.strikes?.find((s) => s.expiry === expiry && s.strike === strike)
  const touched = !!sold?.triggered
  const noRoom = !sold && !!chain.full?.has(expiry)
  const newStrikeTooSmall = !sold && !!coverWei && coverWei >= MIN_COVER && coverWei < (chain.minNewStrike ?? 0n)
  const cantPay = !!quote && me.bal != null && me.bal < quote.premium
  // BTC moved since the strike was picked: the contract would refuse it, so don't ask for signatures.
  const outOfBand = !!strike && !!minStrike && (strike < minStrike || strike > maxStrike)
  const leavesTooLittle = me.hasTrove && autoRepay && !!coverWei && me.debt - coverWei < 2000n * WAD
  // Mezo only accepts a repay that leaves the loan at or above 110% at that price; below it the
  // payout falls back to the wallet (and the loan may already be liquidated).
  const afterRatio = me.hasTrove && strike && coverWei > 0n && me.debt > coverWei ? (me.coll * strike * 100n) / (me.debt - coverWei) / WAD : null
  const repayTooLate = autoRepay && afterRatio != null && afterRatio < MCR

  // Everything that stops a purchase except the premium itself: a swap for the premium is offered
  // only when paying is all that's missing.
  const blocked = !canWrite || !quote || tooBig || touched || noRoom || outOfBand || newStrikeTooSmall || !salesOpen || chain.paused || !!coverError

  async function buy() {
    await run('buy', async () => {
      // Check the shown premium still holds before asking for signatures: BTC and volatility move.
      const [fresh] = await readP('quote', [expiry, strike, coverWei])
      if (fresh * 100n > quote.premium * SLIPPAGE) {
        setQuote({ ...quote, premium: fresh })
        throw new Error(`The premium is now ${musd(fresh)} (it was ${musd(quote.premium)}). Check it and press Buy again.`)
      }
      const deadline = expiry + 86400n
      const sig = autoRepay ? await signRepay(coverWei, deadline) : '0x'
      const maxPremium = (quote.premium * SLIPPAGE) / 100n
      await ensureAllowance(maxPremium)
      const hash = await write(PAYUNG, payungAbi, 'buy', [expiry, strike, coverWei, maxPremium, autoRepay, deadline, sig])
      return { hash, text: `Covered. If BTC touches ${usd(strike)} before ${date(expiry)}, ${musd(coverWei, 0)} ${autoRepay ? 'goes straight into your loan' : 'goes to your wallet'}.` }
    })
  }

  return (
    <main className="protect">
      <section className="gauge-col" aria-label="Price picture">
        <Gauge price={price} strike={strike} liq={liq} />
      </section>

      <section className="form-col">
        <h1>Open an umbrella over your MUSD loan.</h1>
        <p className="lede">
          Pay a small premium for one to four weeks. If BTC falls to your strike before the cover ends, Payung pays MUSD into your loan, before the liquidation line is reached.
        </p>

        {account && (
          <dl className="facts">
            <div><dt>BTC now</dt><dd>{usd(price)} {chain.priceAt && <small title="When Mezo's oracle last updated the price">({ago(chain.priceAt)})</small>}</dd></div>
            <div><dt>Your loan</dt><dd>{me.hasTrove ? musd(me.debt, 0) : me.hasTrove === false ? 'No open loan' : '…'}</dd></div>
            <div><dt>Liquidation at</dt><dd className="danger">{liq ? usd(liq) : '—'}</dd></div>
            {me.hasTrove && price && liq && (
              <div><dt>Collateral ratio</dt><dd>{ratio(me.coll, price, me.debt)} <small>{liq < price ? `(BTC ${((1 - Number(liq) / Number(price)) * 100).toFixed(0)}% above liquidation)` : '(liquidatable now)'}</small></dd></div>
            )}
            {q && (
              <div title="Anyone can redeem MUSD for BTC at face value, starting with the loan with the lowest collateral ratio. A redemption repays debt with your BTC: you lose no value, but you lose that BTC. Payung covers liquidation, not redemption.">
                <dt>Redemption queue</dt>
                <dd>{(me.queue.ahead + 1n).toLocaleString()} of {me.queue.total.toLocaleString()} <small>({musd(me.queue.debtAhead, 0)} of debt is redeemed first)</small></dd>
              </div>
            )}
          </dl>
        )}
        {q && redemptions?.length > 0 && (
          <p className="fine redemptions">
            Mezo has processed {redemptions.length} redemptions since {new Date(redemptions[0].timestamp * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}, the largest {musd(largest, 0)}, the latest on {date(redemptions.at(-1).timestamp)}. Against today's queue, {reaching} of them would have reached your loan.
          </p>
        )}
        {q && largest != null && q.debtAhead < largest && (
          <p className="note">
            Your loan is near the front of Mezo's redemption queue: one redemption the size of the largest Mezo has seen ({musd(largest, 0)}) would reach it. A redemption repays your debt with your BTC at face value, so you keep the value but lose the BTC. Payung covers liquidation, not redemption; raising your collateral ratio moves you back in the queue.
          </p>
        )}
        {viaRecovery && (
          <p className="note">
            Your liquidation line comes from recovery mode. Below {usd(recoveryAt)}, Mezo's system ratio drops under 150%, and loans under 150% become liquidatable before reaching their own 110% line.
          </p>
        )}
        {account && me.hasTrove === false && (
          <p className="note">This wallet has no Mezo loan. You can still buy cover that pays your wallet, or <a href="https://mezo.org/borrow" target="_blank" rel="noreferrer">open a loan on Mezo</a> first.</p>
        )}

        <label className="field">
          <span>Strike: pay out if BTC touches</span>
          <input
            type="range"
            min={minStrike ? Number(minStrike / STEP) : 0}
            max={maxStrike ? Number(maxStrike / STEP) : 0}
            step="1"
            value={strike ? Number(strike / STEP) : 0}
            onChange={(e) => setStrike(BigInt(e.target.value) * STEP)}
            disabled={!price || !strike} // until the default strike is set, a key press would be lost
            aria-valuetext={strike ? usd(strike) : undefined}
          />
          <strong className="big">{usd(strike)}{quote && <small> · {(Number(quote.distance) / 100).toFixed(1)}% below now</small>}</strong>
          {moved && <em className="hint">Your previous strike, {usd(moved)}, is outside today's range of 5–30% below BTC, so the nearest one is picked.</em>}
          {touched && <em className="warn">BTC already touched {usd(strike)} in this cover period, so it no longer sells. Pick another strike or period.</em>}
          {outOfBand && <em className="warn">BTC moved to {usd(price)}, so {usd(strike)} is no longer 5–30% below it. <button className="small" onClick={() => setStrike(strike < minStrike ? minStrike : maxStrike)}>Use {usd(strike < minStrike ? minStrike : maxStrike)}</button></em>}
          {noRoom && <em className="warn">This cover period already sells its maximum of 32 strikes. Pick one of them or another period.</em>}
        </label>

        <fieldset className="field weeks">
          <legend>Cover period: until {expiry ? date(expiry) : '…'}</legend>
          <div className="seg">
            {Array.from({ length: MAX_WEEKS }, (_, i) => i + 1).map((n) => (
              <label key={n} className={weeks === n ? 'on' : ''}>
                <input type="radio" name="weeks" value={n} checked={weeks === n} onChange={() => setWeeks(n)} />
                {n === 1 ? 'This week' : `${n} weeks`}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>Cover amount (MUSD)</span>
          <input inputMode="decimal" value={cover} aria-invalid={!!coverError || tooBig} onChange={(e) => setCover(e.target.value.replace(/[^0-9.]/g, ''))} />
          {coverError && <em className="warn">{coverError}</em>}
          {newStrikeTooSmall && <em className="warn">Nobody has bought {usd(strike)} for this period yet. Opening a new strike takes at least {musd(chain.minNewStrike, 0)} of cover; under that, pick a strike someone already bought.</em>}
          {tooBig && (capacity < MIN_COVER
            ? <em className="warn">The vault's cover is fully booked. Capacity grows when underwriters deposit or when cover expires: {musd(expiring, 0)} of it on {date(chain.expiry)}.</em>
            : <em className="warn">The vault can back {musd(capacity, 0)} more right now. Lower the cover.</em>)}
        </label>

        {me.hasTrove && strike && coverWei > 0n && autoRepay && me.debt > coverWei && (
          <p className="fine">
            At {usd(strike)} your loan sits at {ratio(me.coll, strike, me.debt)} collateral. The payout repays {musd(coverWei, 0)} and lifts it to {ratio(me.coll, strike, me.debt - coverWei)}.
          </p>
        )}

        <label className="check">
          <input type="checkbox" checked={autoRepay} disabled={!!me.smartAccount || me.hasTrove === false} onChange={(e) => setAutoRepay(e.target.checked)} />
          <span>Repay my loan automatically when it pays out (you sign Mezo's repay message once)</span>
        </label>
        {me.smartAccount && <em className="warn">This is a smart-contract account. Mezo only accepts repay signatures from regular wallets, so the payout goes to your wallet.</em>}
        {repayTooLate && (
          <em className="warn">
            At {usd(strike)} even after the payout your loan would sit under 110%, so Mezo would refuse the repay and the payout would go to your wallet.
            Raise the strike above {usd(liq)} or the cover amount.
          </em>
        )}
        {leavesTooLittle && <em className="warn">Mezo loans keep at least 1,800 MUSD of debt. If the repay would go below that, the payout is sent to your wallet instead.</em>}

        <div className="quote">
          <span>Premium for the whole period</span>
          <strong>{quote ? musd(quote.premium) : '—'}</strong>
          {quote && coverWei > 0n && <small>{((Number(quote.premium) / Number(coverWei)) * 100).toFixed(2)}% of cover</small>}
        </div>
        <p className="fine">
          Priced from BTC volatility measured on-chain from Mezo's price feed ({pct(vol, 0)} a year) and the {expiry ? left(expiry) : '…'} the cover runs: the longer it runs, the likelier a touch.
          You pay at most 3% more than this quote.
        </p>
        <Odds btc={btc} price={price} strike={strike} liq={liq} vol={vol} expiry={expiry} />
        {cantPay && <em className="warn">You have {musd(me.bal)}. Borrow or buy MUSD on Mezo to pay the premium.</em>}
        {cantPay && !blocked && me.btc > 0n && <SwapForPremium need={(quote.premium * SLIPPAGE) / 100n - me.bal} me={me} price={price} account={account} busy={busy} run={run} write={write} canWrite={canWrite} />}
        {expiry && !salesOpen && <em className="warn">Cover ending this week stops selling an hour before expiry. Pick 2 weeks or more.</em>}

        {account && !watching ? (
          <button className="primary wide" disabled={blocked || cantPay || !!busy} onClick={buy}>
            {busy === 'buy' ? 'Opening umbrella…' : `Buy cover for ${quote ? musd(quote.premium) : '…'}`}
          </button>
        ) : (
          <button className="primary wide" onClick={connect}>Connect wallet to buy cover</button>
        )}
      </section>
    </main>
  )
}

const HISTORY_POINTS = 24
const ONE_SHARE = 10n ** 24n // 1 pyMUSD: 18 decimals plus the vault's 6-decimal virtual offset
// Volatility samples (every 15 min) are left out: they'd bury everything else. The newest shows as "Last price sample".
const VAULT_EVENTS = ['PolicyBought', 'StrikeTriggered', 'PolicyPaid', 'Deposit', 'Withdraw', 'AutoRepayUpdated', 'MaxUtilizationUpdated', 'PremiumTableUpdated', 'Paused', 'Unpaused']

// Mezo Pools: sell just enough BTC for the premium, so a borrower holding BTC but no spare MUSD
// can buy cover in two clicks. The pool's rate is shown against Mezo's oracle: a gap is a stress sign.
const GAS_RESERVE = 10n ** 12n // BTC kept back for gas: thousands of transactions at Mezo testnet's ~150 wei gas price
function SwapForPremium({ need, me, price, account, busy, run, write, canWrite }) {
  const [swap, setSwap] = useState()
  useEffect(() => {
    let current = true
    btcForMusd(pub, need).then((s) => current && setSwap(s), (e) => current && setSwap({ error: e.shortMessage ?? e.message }))
    return () => { current = false }
  }, [need])
  if (!swap) return <p className="fine">Checking Mezo Pools for a BTC → MUSD quote…</p>
  if (swap.error) return <p className="fine">Mezo Pools can't quote a BTC → MUSD swap right now ({swap.error}).</p>
  const rate = (swap.musdOut * WAD) / swap.btcIn // MUSD per BTC, fee and price impact included
  const gap = price ? Number(((price - rate) * 1000n) / price) / 10 : null
  const short = me.btc < swap.btcIn + GAS_RESERVE
  return (
    <div className="swap">
      <p>
        <strong>Pay with BTC instead:</strong> swap {formatUnits(swap.btcIn, 18).slice(0, 10)} BTC for {musd(swap.musdOut)} on{' '}
        <a href="https://mezo.org/pools" target="_blank" rel="noreferrer">Mezo Pools</a> (BTC/MUSD pool), enough for the premium.
      </p>
      <p className="fine">
        Pool rate {usd(rate)} per BTC{gap != null && <>, {Math.abs(gap).toFixed(1)}% {gap >= 0 ? 'under' : 'over'} Mezo's oracle ({usd(price)})</>}, after the pool fee. You get at least 99% of the quote or the swap reverts.
      </p>
      {short && <em className="warn">Your wallet has {formatUnits(me.btc, 18).slice(0, 10)} BTC; the swap needs {formatUnits(swap.btcIn, 18).slice(0, 10)} plus a little for gas.</em>}
      <button className="small" disabled={!canWrite || short || !!busy} onClick={() => run('swap', async () => {
        const allowance = await pub.readContract({ address: ADDR.btc, abi: mezoAbi, functionName: 'allowance', args: [account, ADDR.poolsRouter] })
        if (allowance < swap.btcIn) await write(ADDR.btc, mezoAbi, 'approve', [ADDR.poolsRouter, swap.btcIn])
        const deadline = nowSec() + 600n
        const hash = await write(ADDR.poolsRouter, poolsAbi, 'swapExactTokensForTokens', [swap.btcIn, (swap.musdOut * 99n) / 100n, swap.route, account, deadline])
        return { hash, text: `Swapped BTC for about ${musd(swap.musdOut)} on Mezo Pools. You can buy the cover now.` }
      })}>{busy === 'swap' ? 'Swapping…' : `Swap ${formatUnits(swap.btcIn, 18).slice(0, 8)} BTC for MUSD`}</button>
    </div>
  )
}

function Underwrite({ chain, me, account, busy, run, write, ensureAllowance, connect, addToken, canWrite }) {
  const [amount, setAmount] = useState('')
  const [activity, setActivity] = useState()
  const [shown, setShown] = useState(12)
  const [history, setHistory] = useState(PAYUNG === ADDR.payung ? undefined : null) // dev override: deployment block unknown
  const wei = parseAmount(amount)
  const sharePrice = chain.supply == null ? null : chain.supply ? (Number(chain.nav) / Number(chain.supply)) * 1e6 : 1 // 6-decimal virtual offset
  const backing = chain.balance != null ? chain.balance - chain.owed : null
  const utilization = backing ? (chain.locked * WAD) / backing : 0n
  const weekPremiums = activity?.filter((a) => a.eventName === 'PolicyBought' && a.args.expiry > nowSec()).reduce((s, a) => s + a.args.premium, 0n)
  // Earned = what the position is worth now + what was withdrawn - what was deposited (pyMUSD sent
  // to or from other wallets isn't counted).
  const mine = (name, who) => activity?.filter((a) => a.eventName === name && a.args.owner.toLowerCase() === who).reduce((s, a) => s + a.args.assets, 0n) ?? 0n
  const deposited = account ? mine('Deposit', account.toLowerCase()) : 0n
  const earned = me.assets != null && deposited > 0n ? me.assets + mine('Withdraw', account.toLowerCase()) - deposited : null

  useEffect(() => {
    // Every vault event since deployment (not just the explorer's 50 newest), newest first.
    const load = () =>
      Promise.all(VAULT_EVENTS.map((e) => explorerLogs(PAYUNG, payungAbi, e, PAYUNG === ADDR.payung ? ADDR.payungBlock : 0n)))
        .then((lists) => setActivity(lists.flat().sort((a, b) => (b.blockNumber === a.blockNumber ? b.logIndex - a.logIndex : b.blockNumber > a.blockNumber ? 1 : -1))))
        .catch(() => setActivity((a) => a ?? null)) // a failed refresh keeps the last good list
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (PAYUNG !== ADDR.payung) return
    // Mezo's RPC serves archive reads: the price of 1 pyMUSD at evenly spaced blocks since deployment.
    pub.getBlockNumber().then(async (head) => {
      const from = ADDR.payungBlock
      const blocks = [...new Set(Array.from({ length: HISTORY_POINTS + 1 }, (_, i) => from + ((head - from) * BigInt(i)) / BigInt(HISTORY_POINTS)))]
      setHistory(await Promise.all(blocks.map(async (blockNumber) => {
        const [assets, block] = await Promise.all([
          pub.readContract({ address: PAYUNG, abi: payungAbi, functionName: 'convertToAssets', args: [ONE_SHARE], blockNumber }),
          pub.getBlock({ blockNumber }),
        ])
        return { t: Number(block.timestamp), p: Number(formatUnits(assets, 18)) }
      })))
    }).catch(() => setHistory(null))
  }, [])

  return (
    <main className="underwrite">
      <h1>Earn MUSD by backing Bitcoin borrowers.</h1>
      <p className="lede">
        Your MUSD backs weekly cover. Borrowers pay premiums into the vault every week. If BTC touches a strike, the vault pays that cover.
        Every policy is fully backed, and open cover across all weeks is capped at {chain.maxUtil != null ? Number(chain.maxUtil) / 100 : '…'}% of the vault, so that is the most it can lose.
        Whoever triggers a touched strike earns 0.1% of its cover (up to 10 MUSD), so anyone can help watch the price.
      </p>
      <dl className="facts">
        <div><dt>Vault value</dt><dd>{musd(chain.nav, 0)}</dd></div>
        <div><dt>Backing open cover</dt><dd>{musd(chain.locked, 0)} <small>({pct(utilization, 0)})</small></dd></div>
        <div><dt>Premiums on open cover</dt><dd>{weekPremiums != null ? musd(weekPremiums) : activity === null ? 'explorer offline' : '…'}</dd></div>
        <div><dt>Free to withdraw</dt><dd>{musd(chain.free, 0)}</dd></div>
        <div><dt>1 pyMUSD</dt><dd>{sharePrice == null ? '…' : `${sharePrice.toFixed(4)} MUSD`}</dd></div>
        <div><dt>BTC volatility (on-chain)</dt><dd>{pct(chain.vol, 0)}</dd></div>
        <div><dt>Last price sample</dt><dd>{chain.observedAt == null ? '…' : chain.observedAt === 0n ? 'none yet' : ago(chain.observedAt)}</dd></div>
      </dl>

      <SharePrice history={history} />

      {chain.touchable?.length > 0 && (
        <div className="banner ok">
          {chain.touchable.map((t) => (
            <p key={`${t.expiry}-${t.strike}`}>
              BTC touched the {usd(t.strike)} strike ({musd(t.cover, 0)} of cover ending {date(t.expiry)}) and nobody has triggered it yet.{' '}
              <button className="small" disabled={!canWrite || !!busy} onClick={() => run('trigger', async () => {
                const hash = await write(PAYUNG, payungAbi, 'trigger', [t.expiry, t.strike])
                return { hash, text: `Triggered ${usd(t.strike)}. You earned ${musd(t.reward)}; the cover is now owed to its holders.` }
              })}>{account ? `Trigger it and earn ${musd(t.reward)}` : 'Connect a wallet to trigger it'}</button>
            </p>
          ))}
        </div>
      )}

      {account ? (
        <div className="split">
          <p>
            Your position: <strong>{musd(me.assets)}</strong>. Wallet: {musd(me.bal)}.
            {earned != null && <> Earned so far: <strong className="earned">{earned >= 0n ? '+' : '−'}{musd(earned >= 0n ? earned : -earned, 4)}</strong> on {musd(deposited, 0)} deposited.</>}
          </p>
          {canWrite && addToken && (
            <p className="tokens">
              <button className="tab" onClick={() => addToken(PAYUNG, 'pyMUSD', 24)}>Add pyMUSD to my wallet</button>
              <button className="tab" onClick={() => addToken(ADDR.musd, 'MUSD', 18)}>Add MUSD to my wallet</button>
            </p>
          )}
          <label className="field">
            <span>Amount (MUSD)</span>
            <input inputMode="decimal" value={amount} aria-invalid={wei === null} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
            {wei === null && <em className="warn">Enter a number, like 250.</em>}
            {wei > 0n && me.bal != null && wei > me.bal && <em className="warn">Your wallet holds {musd(me.bal)}. Deposits can't exceed it.</em>}
          </label>
          <div className="row">
            <button className="primary" disabled={!canWrite || !wei || wei > (me.bal ?? 0n) || chain.price === null || !!busy} onClick={() => run('deposit', async () => {
              await ensureAllowance(wei)
              const hash = await write(PAYUNG, payungAbi, 'deposit', [wei, account])
              return { hash, text: `Deposited ${musd(wei)}.` }
            })}>{busy === 'deposit' ? 'Depositing…' : 'Deposit'}</button>
            <button disabled={!canWrite || !wei || wei > (me.maxWithdraw ?? 0n) || !!busy} onClick={() => run('withdraw', async () => {
              // Max, when your own shares are the limit: redeem all of them (an asset amount goes stale as
              // NAV moves with BTC). When the vault's free MUSD is the limit, withdraw exactly that: it
              // doesn't move with BTC, while shares worth it at signing can be worth more once mined.
              const hash = wei === me.maxWithdraw && me.maxWithdraw >= me.assets
                ? await write(PAYUNG, payungAbi, 'redeem', [me.shares, account, account])
                : await write(PAYUNG, payungAbi, 'withdraw', [wei, account, account])
              return { hash, text: `Withdrew ${musd(wei)}.` }
            })}>{busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}</button>
            {me.maxWithdraw > 0n && <button className="tab" onClick={() => setAmount(formatUnits(me.maxWithdraw, 18))}>Max</button>}
          </div>
          <small>You can withdraw up to {musd(me.maxWithdraw)} now. MUSD backing open cover unlocks as each week's cover expires.</small>
        </div>
      ) : (
        <button className="primary" onClick={connect}>Connect wallet to deposit</button>
      )}

      <Exposure chain={chain} premiums={weekPremiums} />

      <h2>Vault activity</h2>
      {activity === undefined && <p className="lede">Loading from the Mezo explorer…</p>}
      {activity === null && <p className="lede">The Mezo explorer API is not answering. See the <a href={`${EXPLORER}/address/${PAYUNG}`} target="_blank" rel="noreferrer">vault on the explorer</a>.</p>}
      {activity?.length === 0 && <p className="lede">No activity yet.</p>}
      {activity?.length > 0 && (
        <ul className="activity">
          {activity.slice(0, shown).map((a) => (
            <li key={`${a.transactionHash}-${a.logIndex}`}>
              <span>{describe(a)}</span> <a href={`${EXPLORER}/tx/${a.transactionHash}`} target="_blank" rel="noreferrer">{ago(BigInt(a.timestamp))}</a>
            </li>
          ))}
        </ul>
      )}
      {activity?.length > shown && <button className="tab" onClick={() => setShown((n) => n + 24)}>Show older ({activity.length - shown} more)</button>}
    </main>
  )
}

/** Stress test from the vault's own strike book: what it pays if BTC falls to each sold strike
 *  before the cover on it ends. A fall touches every strike above it too, so the payouts add up. */
function Exposure({ chain, premiums }) {
  const open = chain.strikes?.filter((s) => !s.triggered && s.cover > 0n && s.expiry > nowSec())
  if (!open || !chain.price) return null
  if (!open.length) return <p className="lede">No open cover right now, so a BTC fall costs the vault nothing.</p>
  const byStrike = new Map()
  for (const s of open) byStrike.set(s.strike, (byStrike.get(s.strike) ?? 0n) + s.cover)
  // Expected payout at the on-chain volatility: each strike's cover times its chance of a touch before it ends.
  const expected = chain.vol == null ? null : open.reduce((s, o) => s + Number(formatUnits(o.cover, 18)) * touchChance(1 - Number(o.strike) / Number(chain.price), Number(formatUnits(chain.vol, 18)), Number(o.expiry - nowSec())), 0)
  const rows = [...byStrike].sort(([a], [b]) => (b > a ? 1 : -1)).reduce((acc, [strike, cover]) => [...acc, { strike, cover, paid: (acc.at(-1)?.paid ?? chain.owed ?? 0n) + cover }], []) // owed: touched, waiting to be paid
  return (
    <>
      <h2>If BTC falls</h2>
      <p className="lede">What the vault pays if BTC touches each strike it has sold, before that cover ends. A fall passes every strike above it, so each row includes the ones above{chain.owed > 0n && <>, plus {musd(chain.owed, 0)} already owed on touched strikes</>}.</p>
      <table className="exposure">
        <thead><tr><th>BTC falls to</th><th>Drop from now</th><th>Cover at this strike</th><th>Vault pays in total</th><th>Share of vault</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.strike}>
              <td>{usd(r.strike)}</td>
              <td>−{((1 - Number(r.strike) / Number(chain.price)) * 100).toFixed(1)}%</td>
              <td>{musd(r.cover, 0)}</td>
              <td>{musd(r.paid, 0)}</td>
              <td>{chain.nav ? `${((Number(r.paid) / Number(chain.nav)) * 100).toFixed(1)}%` : '…'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {expected != null && premiums != null && (
        <p className="fine expected">
          At the on-chain volatility of {pct(chain.vol, 0)}, the vault expects to pay about <strong>{expected.toLocaleString('en-US', { maximumFractionDigits: 2 })} MUSD</strong> on its open cover,
          against <strong>{musd(premiums)}</strong> of premiums already collected for it. Each strike counts its cover times its chance of a touch before that cover ends.
        </p>
      )}
    </>
  )
}

function describe({ eventName, args }) {
  switch (eventName) {
    case 'PolicyBought': return `Cover bought: ${musd(args.cover, 0)} at ${usd(args.strike)}, premium ${musd(args.premium)}${args.autoRepay ? ', auto-repay' : ''}`
    case 'StrikeTriggered': return `BTC touched ${usd(args.strike)} (at ${usd(args.price)}): ${musd(args.cover, 0)} now owed, ${musd(args.reward)} to the caller`
    case 'PolicyPaid': return `Paid ${musd(args.cover, 0)} ${args.repaidTrove ? 'into a Mezo loan' : 'to a wallet'}`
    case 'Deposit': return `Underwriter deposited ${musd(args.assets, 0)}`
    case 'Withdraw': return `Underwriter withdrew ${musd(args.assets, 0)}`
    case 'VolatilityObserved': return `Volatility sample: BTC ${usd(args.price)}, vol ${pct(args.volatility, 0)}`
    case 'AutoRepayUpdated': return `Policy ${args.id} auto-repay ${args.autoRepay ? 're-signed' : 'turned off'}`
    case 'MaxUtilizationUpdated': return `Owner set the cover cap to ${Number(args.bps) / 100}% of the vault`
    case 'PremiumTableUpdated': return 'Owner updated the premium table'
    case 'Paused': return 'Owner paused new cover'
    case 'Unpaused': return 'Owner resumed new cover'
  }
}

function Policies({ chain, me, account, busy, run, write, signRepay, connect, canWrite, watching, alerts, enableAlerts, renew, signer }) {
  const [phone, setPhone] = useState() // alerts on this account's ntfy topic, each with who signed it
  // pub: a Bitcoin-signed alert is checked against the Mezo Passport account its key owns.
  const loadPhone = useCallback(() => account && readAlerts(account, undefined, pub).then(setPhone, () => setPhone(null)), [account])
  useEffect(() => {
    loadPhone()
    const t = setInterval(loadPhone, 30_000)
    return () => clearInterval(t)
  }, [loadPhone])
  if (!account) return <main><button className="primary" onClick={connect}>Connect wallet to see your cover</button></main>
  const list = me.policies ?? []
  // Every armed signature carries the same Mezo nonce: only one of them can be used.
  const armed = list.filter((p) => p.live && !p.triggered && p.autoRepay && p.problem === null)
  // Borrowing more (or withdrawing BTC) after buying can lift the liquidation line over a strike.
  const { liq } = me.hasTrove ? liquidationPrice(me, chain.price, chain.tcr) : {}

  const rearm = (p) =>
    run(`rearm-${p.id}`, async () => {
      const deadline = p.expiry + 86400n
      const sig = await signRepay(p.cover, deadline)
      const hash = await write(PAYUNG, payungAbi, 'setAutoRepay', [p.id, true, deadline, sig])
      return { hash, text: `Auto-repay re-signed. A payout on this policy now goes into your loan.` }
    })

  // Anyone can call claim; doing it yourself means not waiting for a keeper.
  const claim = (p) =>
    run(`claim-${p.id}`, async () => {
      const tryLoan = p.autoRepay && !p.problem
      const [upper, lower] = tryLoan ? await repayHints(pub, p.holder, p.cover) : [ZERO, ZERO]
      const hash = await write(PAYUNG, payungAbi, 'claim', [p.id, upper, lower])
      // Report where the MUSD actually went (the contract falls back to the wallet if Mezo refuses the repay).
      // write() already saw it succeed, so a failed re-read must not turn a payout into an error.
      const receipt = await waitForReceipt(pub, hash).catch(() => null)
      if (!receipt) return { hash, text: `Paid ${musd(p.cover, 0)}. The transaction shows whether it went into your loan or your wallet.` }
      const [paid] = parseEventLogs({ abi: payungAbi, eventName: 'PolicyPaid', logs: receipt.logs })
      return { hash, text: `Paid ${musd(p.cover, 0)} ${paid?.args.repaidTrove ? 'into your loan' : 'to your wallet (Mezo did not accept the repay signature)'}.` }
    })

  return (
    <main className="policies">
      <h1>My cover</h1>
      {typeof Notification !== 'undefined' && (
        <p className="lede">
          {alerts ? 'Browser alerts are on while this tab is open. You get one when BTC is within 3% of a strike and one when cover pays out.' : (
            <button onClick={enableAlerts}>Alert me in this tab when BTC nears my strike</button>
          )}
        </p>
      )}
      <div className="phone">
        <p>
          <strong>Phone alerts, with this page closed.</strong> The keeper sends one when BTC comes within 3% of your strike and one when your cover pays out.
          Install <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> (Android, iOS or web) and subscribe to <code>{topicFor(account)}</code>.
        </p>
        <p>
          <a href={`${NTFY}/${topicFor(account)}`} target="_blank" rel="noreferrer">Open my alerts in ntfy</a>{' '}
          <button className="small" disabled={!canWrite || !!busy} onClick={() => run('ntfy', async () => {
            await notify(account, { title: 'Payung test alert', message: 'Alerts about your cover will arrive here.', tag: 'test' }, signer)
            setTimeout(loadPhone, 2000) // ntfy.sh shows a new message within a second or two
            return { text: `Test alert sent to ${topicFor(account)}, signed by your ${signer.bitcoin ? 'Bitcoin ' : ''}wallet. If ntfy is subscribed, it is on your phone now.` }
          })}>{busy === 'ntfy' ? 'Sending…' : 'Send a test alert'}</button>
        </p>
        <p className="fine">
          Anyone can post to an ntfy topic, so Payung alerts are signed and never contain links or ask you to sign anything. The list below checks each one.
        </p>
        {phone?.length > 0 && (
          <ul className="alerts">
            {phone.slice(0, 5).map((a) => {
              const keeper = KEEPERS.some((k) => k.toLowerCase() === a.signer?.toLowerCase())
              const mine = a.signer?.toLowerCase() === account.toLowerCase()
              return (
                <li key={a.id}>
                  <span className={keeper || mine ? 'pill active' : 'pill expired'}>{mine ? (watching ? 'Signed by this wallet' : 'Signed by you') : keeper ? 'Signed by the Payung keeper' : 'Not from Payung, ignore it'}</span>{' '}
                  {a.title} <small>{ago(BigInt(a.time))}</small>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {me.policies === undefined ? (
        <p className="lede">Reading your cover…</p>
      ) : list.length === 0 ? (
        <p className="lede">You have no cover yet. Open the Protect tab to cover your loan for this week.</p>
      ) : (
        <table>
          <thead><tr><th>Strike</th><th>Cover</th><th>Expires</th><th>Pays into</th><th>Status</th></tr></thead>
          <tbody>
            {list.map((p) => {
              const status = p.claimed ? 'Paid' : p.triggered ? 'Touched, paying out' : p.live ? 'Active' : 'Expired'
              return (
                <tr key={p.id}>
                  <td>{usd(p.strike)}</td>
                  <td>{musd(p.cover, 0)}</td>
                  <td>
                    {date(p.expiry)}{p.live && !p.triggered && <small> · {left(p.expiry)} left <a href={calendar(p)} download={`payung-cover-${p.id}.ics`}>Add to calendar</a></small>}
                    {!p.claimed && !p.triggered && chain.expiry && p.expiry + WEEK < chain.expiry + BigInt(MAX_WEEKS) * WEEK && (
                      <> <button className="small" onClick={() => renew(p)}>{p.live ? 'Renew for the next week' : 'Buy again'}</button></>
                    )}
                  </td>
                  <td>
                    {!p.autoRepay ? 'Wallet' : !p.live ? 'Loan' : p.problem === undefined ? 'Loan (checking the repay…)' : p.problem ? (
                      <>
                        <span className="warn-inline" title={p.problem}>Wallet (repay signature no longer valid)</span>{' '}
                        <button className="small" disabled={!canWrite || !!busy} onClick={() => rearm(p)}>{busy === `rearm-${p.id}` ? 'Signing…' : 'Re-sign'}</button>
                      </>
                    ) : <span title="Dry-run of Mezo's repay just succeeded">Loan, repay checked</span>}
                    {liq && p.live && !p.triggered && p.strike <= liq && (
                      <em className="warn under-liq"> Your loan is now liquidated at {usd(liq)}, above this strike: it would be liquidated before this cover pays.</em>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${status.split(',')[0].toLowerCase()}`}>{status}</span>
                    {p.triggered && !p.claimed && (
                      <> <button className="small" disabled={!canWrite || !!busy} onClick={() => claim(p)}>{busy === `claim-${p.id}` ? 'Paying…' : 'Pay out now'}</button></>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {armed.length > 1 && (
        <p className="fine shared-nonce">
          Mezo gives each borrower one signature counter, so your {armed.length} armed policies share one repay signature slot. The first to pay out goes into your loan and uses it up; the others would then pay your wallet until you re-sign them here.
        </p>
      )}
    </main>
  )
}

/** An .ics event at the cover's expiry with a reminder a day before, to decide whether to renew. */
function calendar(p) {
  const stamp = (t) => new Date(Number(t) * 1000).toISOString().replace(/[-:]|\.\d{3}/g, '')
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Payung//Cover//EN', 'BEGIN:VEVENT',
    `UID:payung-${PAYUNG}-${p.id}`, `DTSTAMP:${stamp(nowSec())}`, `DTSTART:${stamp(p.expiry)}`, `DTEND:${stamp(p.expiry)}`,
    `SUMMARY:${`Payung cover ends (${usd(p.strike)} strike, ${musd(p.cover, 0)})`.replace(/[,;\\]/g, '\\$&')}`, // RFC 5545 text escaping
    `DESCRIPTION:Your liquidation cover ends now. Renew it for the next week: ${renewLink(p)}`,
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Payung cover ends tomorrow', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].map((l) => l.match(/.{1,74}/g).join('\r\n ')).join('\r\n') // RFC 5545: fold lines over 75 octets
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`
}

/** How likely is a touch: the on-chain-vol model next to what BTC actually did on Mezo's oracle,
 *  with the 30-day path drawn against the strike and the liquidation line. */
function Odds({ btc, price, strike, liq, vol, expiry }) {
  if (btc === undefined) return <p className="fine odds-wait">Reading 30 days of BTC from Mezo's oracle…</p>
  if (!btc?.length || !price || !strike || !expiry || vol == null) return null
  const drop = 1 - Number(strike) / Number(price)
  const seconds = Number(expiry - nowSec())
  const model = touchChance(drop, Number(formatUnits(vol, 18)), seconds)
  const { hits, windows } = touchRate(btc, drop, seconds)
  const low = btc.reduce((m, h) => (h.p < m.p ? h : m))
  const marks = [Number(strike) / 1e18, liq ? Number(liq) / 1e18 : null].filter(Boolean)
  const lo = Math.min(low.p, ...marks) * 0.995
  const hi = Math.max(...btc.map((h) => h.p)) * 1.005
  const x = (t) => ((t - btc[0].t) / (btc.at(-1).t - btc[0].t || 1)) * 300
  const y = (p) => 78 - ((p - lo) / (hi - lo)) * 76
  const pctOf = (v) => (v < 0.001 ? 'under 0.1%' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`)
  const separate = Math.floor((btc.at(-1).t - btc[0].t) / seconds) // windows overlap; this many don't
  return (
    <figure className="history odds">
      <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label={`BTC over 30 days on Mezo's oracle, low ${usd(BigInt(Math.round(low.p)) * WAD)}, against the ${usd(strike)} strike`}>
        <line x1="0" x2="300" y1={y(Number(strike) / 1e18)} y2={y(Number(strike) / 1e18)} className="strike" />
        {liq && <line x1="0" x2="300" y1={y(Number(liq) / 1e18)} y2={y(Number(liq) / 1e18)} className="liq" />}
        <polyline points={btc.map((h) => `${x(h.t).toFixed(1)},${y(h.p).toFixed(1)}`).join(' ')} />
      </svg>
      <figcaption>
        Chance BTC touches {usd(strike)} in the {left(expiry)} left: {model < 0.001 ? '' : 'about '}<strong>{pctOf(model)}</strong> at the on-chain volatility.
        {windows > 0 && <> Over the last 30 days on Mezo's oracle, BTC fell {(drop * 100).toFixed(1)}% or more within {left(expiry)} in {hits} of {windows} overlapping stretches{separate < 4 ? ` (30 days hold only ${separate || 'under one'} separate stretch${separate === 1 ? '' : 'es'} this long, so read it loosely)` : ''}.</>}
        {' '}30-day low: {usd(BigInt(Math.round(low.p)) * WAD)} on {date(low.t)}. Orange line: your strike{liq ? '; red: liquidation' : ''}.
      </figcaption>
    </figure>
  )
}

/** 1 pyMUSD over time, read from the vault at past blocks. */
function SharePrice({ history }) {
  if (history === undefined) return <p className="lede">Reading the share price history from Mezo…</p>
  if (!history || history.length < 2) return null
  const first = history[0]
  const last = history.at(-1)
  const change = last.p / first.p - 1
  const days = (last.t - first.t) / 86400
  const lo = Math.min(...history.map((h) => h.p))
  const hi = Math.max(...history.map((h) => h.p))
  const x = (t) => ((t - first.t) / (last.t - first.t || 1)) * 300
  const y = (p) => 56 - ((p - lo) / (hi - lo || 1)) * 52
  const fmt = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
  return (
    <figure className="history">
      <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label={`1 pyMUSD went from ${first.p.toFixed(4)} to ${last.p.toFixed(4)} MUSD since ${date(first.t)}`}>
        <polyline points={history.map((h) => `${x(h.t).toFixed(1)},${y(h.p).toFixed(1)}`).join(' ')} />
      </svg>
      <figcaption>
        1 pyMUSD: {first.p.toFixed(4)} → {last.p.toFixed(4)} MUSD since launch on {date(first.t)} ({fmt(change)}
        {/* Compounding a day of premiums over a year printed +191,698,721,092%: wait for a full week and don't compound. */}
        {days >= 7 ? `, ${fmt((change * 365) / days)} a year at this pace, not compounded` : ''}). Read from the vault at {history.length} past blocks.
      </figcaption>
    </figure>
  )
}

/** Vertical price shaft: where BTC is, where the umbrella opens, where liquidation sits. */
function Gauge({ price, strike, liq }) {
  if (!price) return <div className="gauge empty">Reading the Mezo price feed…</div>
  const top = Number(price) * 1.04
  const bottom = Number(price) * 0.62
  const y = (v) => Math.min(100, Math.max(0, ((top - Number(v)) / (top - bottom)) * 100))
  return (
    <svg className="gauge" viewBox="0 0 250 400" role="img" aria-label={`BTC ${usd(price)}, strike ${usd(strike)}${liq ? `, liquidation ${usd(liq)}` : ''}`}>
      <defs>
        <pattern id="rain" width="14" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(12)">
          <line x1="7" y1="0" x2="7" y2="9" className="drop" />
        </pattern>
      </defs>
      <rect x="40" y="0" width="72" height="400" className="shaft" />
      {strike && <rect x="40" y="0" width="72" height={(y(strike) / 100) * 400} fill="url(#rain)" />}
      {strike && (
        <g transform={`translate(76 ${(y(strike) / 100) * 400})`} className="canopy">
          <path d="M-62 0 Q-62 -38 0 -40 Q62 -38 62 0 Q46 -10 31 0 Q15 -10 0 0 Q-15 -10 -31 0 Q-46 -10 -62 0Z" />
        </g>
      )}
      <Line y={y(price)} label="BTC now" value={usd(price)} cls="now" />
      {strike && <Line y={y(strike)} label="Payout" value={usd(strike)} cls="strike" />}
      {liq && <Line y={y(liq)} label="Liquidation" value={usd(liq)} cls="liq" />}
    </svg>
  )
}

function Line({ y, label, value, cls }) {
  const py = (y / 100) * 400
  return (
    <g className={`mark ${cls}`}>
      <line x1="30" x2="122" y1={py} y2={py} />
      <text x="144" y={py - 3}>{value}</text>
      <text x="144" y={py + 11} className="sub">{label}</text>
    </g>
  )
}

/** The card's horizon: a desert at sunset, a paper umbrella (payung) planted over a Bitcoin. Decoration. */
function Horizon() {
  return (
    <svg className="horizon" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hz-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7ecdf" />
          <stop offset="0.45" stopColor="#f8cf9c" />
          <stop offset="1" stopColor="#f19a55" />
        </linearGradient>
        <radialGradient id="hz-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff4d6" />
          <stop offset="0.55" stopColor="#ffd98f" stopOpacity="0.9" />
          <stop offset="1" stopColor="#f8b768" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hz-dune" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c8642f" />
          <stop offset="1" stopColor="#8f3a17" />
        </linearGradient>
        <linearGradient id="hz-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a2e14" />
          <stop offset="1" stopColor="#4a1a0b" />
        </linearGradient>
      </defs>
      <rect width="1200" height="300" fill="url(#hz-sky)" />
      <circle cx="300" cy="190" r="120" fill="url(#hz-sun)" />
      <circle cx="300" cy="190" r="42" fill="#fff1cf" />
      <g fill="#f3b47a" opacity="0.8">
        <ellipse cx="760" cy="70" rx="120" ry="9" />
        <ellipse cx="860" cy="88" rx="80" ry="6" />
        <ellipse cx="150" cy="96" rx="95" ry="7" />
      </g>
      {/* far mesas */}
      <path d="M0 214 L60 214 L74 186 L170 186 L184 214 L520 214 L540 196 L640 196 L652 214 L880 214 L900 178 L1010 178 L1028 214 L1200 214 L1200 300 L0 300Z" fill="#e39a5e" opacity="0.85" />
      {/* rolling dunes */}
      <path d="M0 240 C150 214 260 226 380 238 C520 252 640 216 780 222 C920 228 1040 252 1200 232 L1200 300 L0 300Z" fill="url(#hz-dune)" />
      {/* near ground and cacti */}
      <path d="M0 270 C180 252 330 276 520 268 C700 260 860 282 1200 262 L1200 300 L0 300Z" fill="url(#hz-near)" />
      <g fill="#3d1508">
        <path d="M112 270 v-46 a8 8 0 0 1 16 0 v46Z M112 248 h-12 v-14 a6 6 0 0 1 12 0Z M128 242 h12 v-18 a6 6 0 0 0 -12 0Z" />
        <path d="M1082 266 v-34 a6 6 0 0 1 12 0 v34Z M1082 250 h-9 v-10 a4.5 4.5 0 0 1 9 0Z" />
      </g>
      {/* the payung over a Bitcoin */}
      <g transform="translate(900 150)">
        <path d="M-6 0 L2 118" stroke="#3a170a" strokeWidth="5" strokeLinecap="round" />
        <path d="M-120 18 Q-110 -58 -4 -66 Q102 -58 116 18 Q96 4 76 20 Q56 4 36 20 Q16 4 -4 20 Q-24 4 -44 20 Q-64 4 -84 20 Q-102 4 -120 18Z" fill="#eb6919" />
        <path d="M-4 -66 Q-30 -20 -44 20 M-4 -66 Q-4 -20 -4 20 M-4 -66 Q24 -20 36 20 M-4 -66 Q-70 -30 -84 20 M-4 -66 Q62 -30 76 20" fill="none" stroke="#a73513" strokeWidth="2.2" opacity="0.7" />
        <circle cx="-4" cy="-68" r="5" fill="#a73513" />
        <circle cx="40" cy="104" r="22" fill="#f89737" stroke="#a73513" strokeWidth="3" />
        <text x="40" y="112" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize="24" fill="#5f2110">₿</text>
      </g>
    </svg>
  )
}

function Umbrella() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12 Q2 3 12 2.5 Q22 3 22 12 Q19.5 10 17 12 Q14.5 10 12 12 Q9.5 10 7 12 Q4.5 10 2 12Z" fill="var(--turmeric)" />
      <path d="M12 12 V19.5 Q12 21.5 10 21.5 Q8.5 21.5 8.5 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
