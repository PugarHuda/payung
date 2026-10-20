import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseUnits } from 'viem'
import { mezoTestnet, ADDR, payungAbi, mezoAbi, repayTypedData, GAS } from '../../shared/mezo.js'
import './App.css'

const PAYUNG = new URLSearchParams(location.search).get('vault') ?? ADDR.payung
const ZERO = '0x0000000000000000000000000000000000000000'
const STEP = 1000n * 10n ** 18n
const MCR = 110n // liquidation at 110% collateral ratio
const TARGET_CR = 150n // cover sized to lift the trove back to 150% at the strike
const pub = createPublicClient({ chain: mezoTestnet, transport: http() })

const usd = (v, d = 0) => (v == null ? '…' : '$' + Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d }))
const musd = (v, d = 2) => (v == null ? '…' : Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d }) + ' MUSD')
const date = (t) => new Date(Number(t) * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
const roundUp = (v, step) => ((v + step - 1n) / step) * step

export default function App() {
  const [account, setAccount] = useState()
  const [tab, setTab] = useState('protect')
  const [chain, setChain] = useState({})
  const [me, setMe] = useState({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState()
  const deployed = PAYUNG !== ZERO

  const wallet = useMemo(
    () => (window.ethereum ? createWalletClient({ chain: mezoTestnet, transport: custom(window.ethereum) }) : null),
    [],
  )
  const readP = useCallback((functionName, args = []) => pub.readContract({ address: PAYUNG, abi: payungAbi, functionName, args }), [])
  const readM = useCallback((address, functionName, args = []) => pub.readContract({ address, abi: mezoAbi, functionName, args }), [])

  const refresh = useCallback(async () => {
    const price = await readM(ADDR.priceFeed, 'fetchPrice').catch(() => null)
    const next = { price }
    if (deployed) {
      ;[next.nav, next.free, next.activeCover, next.expiry, next.supply] = await Promise.all([
        readP('totalAssets'), readP('freeLiquidity'), readP('activeCover'), readP('currentExpiry'), readP('totalSupply'),
      ])
    }
    setChain(next)
    if (!account) return
    const [debtColl, status, bal] = await Promise.all([
      readM(ADDR.troveManager, 'getEntireDebtAndColl', [account]),
      readM(ADDR.troveManager, 'getTroveStatus', [account]),
      readM(ADDR.musd, 'balanceOf', [account]),
    ])
    const mine = { coll: debtColl[0], debt: debtColl[1] + debtColl[2], hasTrove: status === 1n, bal }
    if (deployed) {
      const [shares, ids] = await Promise.all([readP('balanceOf', [account]), readP('policiesOf', [account])])
      mine.shares = shares
      mine.assets = await readP('convertToAssets', [shares])
      mine.maxWithdraw = await readP('maxWithdraw', [account])
      mine.policies = await Promise.all(
        [...ids].reverse().map(async (id) => {
          const p = await readP('policy', [id])
          const [, triggered] = await readP('strikes', [p.expiry, p.strike])
          return { id, ...p, triggered }
        }),
      )
    }
    setMe(mine)
  }, [account, deployed, readM, readP])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  async function connect() {
    if (!wallet) return setNotice({ kind: 'error', text: 'No browser wallet found. Install MetaMask or another EVM wallet, then reload.' })
    const [addr] = await wallet.requestAddresses()
    try {
      await wallet.switchChain({ id: mezoTestnet.id })
    } catch {
      await wallet.addChain({ chain: mezoTestnet })
    }
    setAccount(addr)
  }

  async function run(label, fn) {
    setBusy(label)
    setNotice()
    try {
      const msg = await fn()
      setNotice({ kind: 'ok', text: msg })
      await refresh()
    } catch (e) {
      setNotice({ kind: 'error', text: e.shortMessage ?? e.message })
    } finally {
      setBusy('')
    }
  }

  async function write(address, abi, functionName, args) {
    const req = { account, address, abi, functionName, args }
    const hash = await wallet.writeContract({ ...req, gas: GAS })
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`Transaction failed: ${hash}`)
    return hash
  }

  async function ensureAllowance(amount) {
    const allowance = await readM(ADDR.musd, 'allowance', [account, PAYUNG])
    if (allowance < amount) await write(ADDR.musd, mezoAbi, 'approve', [PAYUNG, amount])
  }

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="./">
          <Umbrella /> Payung
        </a>
        <nav aria-label="Sections">
          {[['protect', 'Protect my loan'], ['underwrite', 'Earn by underwriting'], ['policies', 'My cover']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        {account ? <span className="acct">{account.slice(0, 6)}…{account.slice(-4)}</span> : <button className="primary" onClick={connect}>Connect wallet</button>}
      </header>

      {!deployed && <p className="banner">Vault address not set. Open this page with <code>?vault=0x…</code> after deploying.</p>}
      {notice && <p className={`banner ${notice.kind}`} role="status">{notice.text}</p>}

      {tab === 'protect' && <Protect {...{ chain, me, account, wallet, busy, run, write, ensureAllowance, readP, connect }} />}
      {tab === 'underwrite' && <Underwrite {...{ chain, me, account, busy, run, write, ensureAllowance, connect }} />}
      {tab === 'policies' && <Policies {...{ me, account, connect }} />}

      <footer>
        Mezo testnet · settles on Mezo's MUSD price feed · <a href={`${mezoTestnet.blockExplorers.default.url}/address/${PAYUNG}`} target="_blank" rel="noreferrer">vault contract</a>
      </footer>
    </div>
  )
}

function Protect({ chain, me, account, wallet, busy, run, write, ensureAllowance, readP, connect }) {
  const { price, expiry, free } = chain
  const liq = me.hasTrove && me.coll > 0n ? (me.debt * MCR * 10n ** 16n) / me.coll : null
  const minStrike = price ? roundUp((price * 70n) / 100n, STEP) : null
  const maxStrike = price ? ((price * 95n) / 100n / STEP) * STEP : null

  const [strike, setStrike] = useState()
  const [cover, setCover] = useState('')
  const [autoRepay, setAutoRepay] = useState(true)
  const [quote, setQuote] = useState()

  // Default: umbrella opens a little above the liquidation line, cover lifts the trove to 150%.
  useEffect(() => {
    if (strike || !price) return
    let s = liq ? roundUp((liq * 108n) / 100n, STEP) : ((price * 90n) / 100n / STEP) * STEP
    if (s < minStrike) s = minStrike
    if (s > maxStrike) s = maxStrike
    setStrike(s)
    if (me.hasTrove) {
      const need = me.debt - (me.coll * s * 100n) / TARGET_CR / 10n ** 18n
      setCover(need > 10n ** 19n ? (roundUp(need, 10n ** 19n) / 10n ** 18n).toString() : '100')
    } else setCover('500')
  }, [price, liq, me, strike, minStrike, maxStrike])

  const coverWei = useMemo(() => {
    try {
      return parseUnits(cover || '0', 18)
    } catch {
      return 0n
    }
  }, [cover])

  useEffect(() => {
    if (!strike || coverWei < 10n ** 19n || PAYUNG === ZERO) return setQuote()
    readP('quote', [strike, coverWei]).then(([premium, distance]) => setQuote({ premium, distance })).catch(() => setQuote())
  }, [strike, coverWei, readP, price])

  const tooBig = free != null && coverWei > free
  const leavesTooLittle = me.hasTrove && autoRepay && me.debt - coverWei < 2000n * 10n ** 18n

  async function buy() {
    await run('buy', async () => {
      const deadline = expiry + 86400n
      let sig = '0x'
      if (autoRepay) {
        const nonce = await pub.readContract({ address: ADDR.sigs, abi: mezoAbi, functionName: 'getNonce', args: [account] })
        sig = await wallet.signTypedData({ account, ...repayTypedData({ amount: coverWei, borrower: account, nonce, deadline }) })
      }
      await ensureAllowance(quote.premium)
      await write(PAYUNG, payungAbi, 'buy', [strike, coverWei, autoRepay, deadline, sig])
      return `Covered. If BTC touches ${usd(strike)} before ${date(expiry)}, ${musd(coverWei, 0)} ${autoRepay ? 'goes straight into your loan' : 'goes to your wallet'}.`
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
          Pay a small premium for this week. If BTC falls to your strike before {expiry ? date(expiry) : 'Thursday 00:00 UTC'}, Payung pays MUSD into your loan, before the 110% liquidation line is reached.
        </p>

        {account && (
          <dl className="facts">
            <div><dt>BTC now</dt><dd>{usd(price)}</dd></div>
            <div><dt>Your loan</dt><dd>{me.hasTrove ? musd(me.debt, 0) : 'No open loan'}</dd></div>
            <div><dt>Liquidation at</dt><dd className="danger">{liq ? usd(liq) : '—'}</dd></div>
          </dl>
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
            disabled={!price}
          />
          <strong className="big">{usd(strike)}{quote && <small> · {(Number(quote.distance) / 100).toFixed(1)}% below now</small>}</strong>
        </label>

        <label className="field">
          <span>Cover amount (MUSD)</span>
          <input inputMode="decimal" value={cover} onChange={(e) => setCover(e.target.value.replace(/[^0-9.]/g, ''))} />
          {tooBig && <em className="warn">The vault can back {musd(free, 0)} right now. Lower the cover.</em>}
        </label>

        <label className="check">
          <input type="checkbox" checked={autoRepay} onChange={(e) => setAutoRepay(e.target.checked)} />
          <span>Repay my loan automatically when it pays out (you sign Mezo's repay message once)</span>
        </label>
        {leavesTooLittle && <em className="warn">Mezo loans keep at least 1,800 MUSD of debt. If the repay would go below that, the payout is sent to your wallet instead.</em>}

        <div className="quote">
          <span>Premium for this week</span>
          <strong>{quote ? musd(quote.premium) : '—'}</strong>
          {quote && coverWei > 0n && <small>{((Number(quote.premium) / Number(coverWei)) * 100).toFixed(2)}% of cover</small>}
        </div>

        {account ? (
          <button className="primary wide" disabled={!quote || tooBig || !!busy} onClick={buy}>
            {busy === 'buy' ? 'Opening umbrella…' : `Buy cover for ${quote ? musd(quote.premium) : '…'}`}
          </button>
        ) : (
          <button className="primary wide" onClick={connect}>Connect wallet to buy cover</button>
        )}
      </section>
    </main>
  )
}

function Underwrite({ chain, me, account, busy, run, write, ensureAllowance, connect }) {
  const [amount, setAmount] = useState('')
  const wei = (() => {
    try {
      return parseUnits(amount || '0', 18)
    } catch {
      return 0n
    }
  })()
  const sharePrice = chain.supply ? Number(chain.nav) / Number(chain.supply) * 1e6 : 1 // 6-decimal virtual offset

  return (
    <main className="underwrite">
      <h1>Earn MUSD by backing Bitcoin borrowers.</h1>
      <p className="lede">
        Your MUSD backs weekly cover. Borrowers pay premiums into the vault every week. If BTC touches a strike, the vault pays that cover. Every policy is fully backed, so the most the vault can lose in a week is the cover it sold.
      </p>
      <dl className="facts">
        <div><dt>Vault value</dt><dd>{musd(chain.nav, 0)}</dd></div>
        <div><dt>Backing open cover</dt><dd>{musd(chain.activeCover, 0)}</dd></div>
        <div><dt>Free to withdraw</dt><dd>{musd(chain.free, 0)}</dd></div>
        <div><dt>1 pyMUSD</dt><dd>{sharePrice.toFixed(4)} MUSD</dd></div>
      </dl>

      {account ? (
        <div className="split">
          <div>
            <p>Your position: <strong>{musd(me.assets)}</strong>. Wallet: {musd(me.bal)}.</p>
            <label className="field">
              <span>Amount (MUSD)</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
            </label>
            <div className="row">
              <button className="primary" disabled={!wei || !!busy} onClick={() => run('deposit', async () => {
                await ensureAllowance(wei)
                await write(PAYUNG, payungAbi, 'deposit', [wei, account])
                return `Deposited ${musd(wei)}.`
              })}>{busy === 'deposit' ? 'Depositing…' : 'Deposit'}</button>
              <button disabled={!wei || wei > (me.maxWithdraw ?? 0n) || !!busy} onClick={() => run('withdraw', async () => {
                await write(PAYUNG, payungAbi, 'withdraw', [wei, account, account])
                return `Withdrew ${musd(wei)}.`
              })}>{busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}</button>
            </div>
            <small>You can withdraw up to {musd(me.maxWithdraw)} now. MUSD backing open cover unlocks at the weekly expiry.</small>
          </div>
        </div>
      ) : (
        <button className="primary" onClick={connect}>Connect wallet to deposit</button>
      )}
    </main>
  )
}

function Policies({ me, account, connect }) {
  if (!account) return <main><button className="primary" onClick={connect}>Connect wallet to see your cover</button></main>
  const now = BigInt(Math.floor(Date.now() / 1000))
  const list = me.policies ?? []
  return (
    <main className="policies">
      <h1>My cover</h1>
      {list.length === 0 ? (
        <p className="lede">You have no cover yet. Open the Protect tab to cover your loan for this week.</p>
      ) : (
        <table>
          <thead><tr><th>Strike</th><th>Cover</th><th>Expires</th><th>Pays into</th><th>Status</th></tr></thead>
          <tbody>
            {list.map((p) => {
              const status = p.claimed ? 'Paid' : p.triggered ? 'Touched, paying out' : now >= p.expiry ? 'Expired' : 'Active'
              return (
                <tr key={p.id}>
                  <td>{usd(p.strike)}</td><td>{musd(p.cover, 0)}</td><td>{date(p.expiry)}</td>
                  <td>{p.autoRepay ? 'Loan' : 'Wallet'}</td><td><span className={`pill ${status.split(',')[0].toLowerCase()}`}>{status}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </main>
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
      <text x="130" y={py - 3}>{value}</text>
      <text x="130" y={py + 11} className="sub">{label}</text>
    </g>
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
