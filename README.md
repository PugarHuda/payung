# Payung

[![Tests](https://github.com/PugarHuda/payung/actions/workflows/test.yml/badge.svg)](https://github.com/PugarHuda/payung/actions/workflows/test.yml) [![Keeper](https://github.com/PugarHuda/payung/actions/workflows/keeper.yml/badge.svg)](https://github.com/PugarHuda/payung/actions/workflows/keeper.yml)

**Liquidation cover for Mezo MUSD borrowers.** *Payung* is Indonesian for umbrella.

Mezo lets you live off your Bitcoin without selling it: lock BTC, borrow MUSD. The one thing that can take your BTC away is a price drop to the liquidation line. Today a borrower's only defences are watching the price or borrowing less. Payung lets them **buy protection** instead.

- **Borrowers** pay a small premium in MUSD for the rest of the week. If the Mezo BTC price touches their strike before Thursday 00:00 UTC (the Mezo Earn epoch boundary), Payung pays a fixed MUSD amount **straight into their trove** through Mezo's own `repayMUSDWithSignature`, lifting the collateral ratio before liquidation.
- **Underwriters** deposit MUSD into an ERC-4626 vault (`pyMUSD`) and earn the premiums. It is a new MUSD yield source with its own risk profile, uncorrelated with Stability Pool liquidations or LP fees, and with a hard cap on how much it can lose in one week.

Built for the [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10), Track 1 (DeFi).

## Live on Mezo testnet (chain 31611)

| | |
|---|---|
| App | https://pugarhuda.github.io/payung/ |
| Payung vault | [`0xaDe0CA33Ed6b6616BE87E3623fDCe38C4dd84633`](https://explorer.test.mezo.org/address/0xaDe0CA33Ed6b6616BE87E3623fDCe38C4dd84633), Sourcify `exact_match` |
| Underwriter deposit (1,500 MUSD) | [`0xea1a5d1a…a873`](https://explorer.test.mezo.org/tx/0xea1a5d1ad7787fbebdef0d5643e6bd6fce4446d09366acd59f22b60c7aeba873) |
| Cover with pre-signed auto-repay (500 MUSD at $71,000, ~40 h left, premium 1.25 MUSD) | [`0x1c694e52…9201`](https://explorer.test.mezo.org/tx/0x1c694e52fc3b75eae684e9e8aabc79a4c91f5b0540f129f2266459a1115e9201) |
| Cover bought through the app by the e2e test | [`0x115d38f0…d753`](https://explorer.test.mezo.org/tx/0x115d38f0a932df7dbaa73a7010a873ce4b17190d273ca424478dea813805d753) |
| Auto-repay re-signed after a real Mezo nonce was used up | [`0xeb9d88d4…1e95`](https://explorer.test.mezo.org/tx/0xeb9d88d4132bfacdd36ba2ac62a01c383171b6aed4fafd6248f4bcdc3d611e95) |
| Keeper | GitHub Actions every 5 minutes ([runs](https://github.com/PugarHuda/payung/actions/workflows/keeper.yml)), dedicated wallet `0x4FF8d702D8CC8c106BB1C7C6Bf56459DE4300d9D` |
| Touch → trigger → repay into a real trove | Fork tests against the live MUSD contracts (see below); a real touch on testnet needs BTC to actually fall 5%+ |

## How it works

```
underwriters ──MUSD──▶ Payung vault (ERC-4626) ◀──premium── borrower
                          │  backs every policy, open cover ≤ 50% of the vault
   Mezo PriceFeed ──▶ poke()             permissionless: on-chain BTC volatility
                  ──▶ trigger(strike)    permissionless, once price ≤ strike
                          │
                      claim(policy)      permissionless (keeper)
                          ├─ repayMUSDWithSignature(cover, borrower, sig) ──▶ borrower's trove
                          └─ fallback: MUSD to the borrower's wallet
```

1. **Buy.** `buy(strike, cover, maxPremium, autoRepay, sigDeadline, signature)`. Strikes sit on a $1,000 grid, 5% to 30% below spot. With `autoRepay`, the borrower signs Mezo's `RepayMUSD(amount, borrower, nonce, deadline)` once in the app. `maxPremium` protects the buyer if BTC moves between quote and execution.
2. **Price.** A one-touch probability depends on distance / (volatility × √time). Payung rescales the strike distance by `(50% / vol) × √(week / time left)` and reads a one-week, 50%-vol table (1.25× margin). So cover gets cheaper as the week runs out, and dearer when BTC is volatile.
3. **Volatility from Mezo itself.** `poke()` samples Mezo's PriceFeed (every 15 minutes or more; buys and triggers sample too) into an EWMA of annualised variance with a one-day time constant, clamped to 35–200%. Gaps over a day restart sampling instead of producing one huge sample. No external vol oracle and no owner input.
4. **Touch.** Anyone calls `trigger(strike)` when `PriceFeed.fetchPrice() <= strike` before expiry. One-touch, not European: cover pays when the danger happens, not on Thursday.
5. **Pay.** Anyone calls `claim(id, hints)`. Mezo verifies the borrower's signature and burns the vault's MUSD against the trove debt. If the repay would fail, the MUSD goes to the borrower's wallet instead. That happens when the signature was voided, the trove is closed, or the repay would break the 1,800 MUSD minimum debt.
6. **Re-arm.** Mezo uses one nonce per borrower for every signed action, so a later signed Mezo action voids the payout signature. The app dry-runs the repay as the vault on every refresh. If it would fail, a **Re-sign** button calls `setAutoRepay` with a fresh signature.
7. **Expire.** Untriggered cover lapses at Thursday 00:00 UTC. The NAV mark of open cover decays with time left, so premiums flow to underwriters smoothly through the week instead of jumping at expiry.

## Why it is deep on Mezo

- **MUSD is the whole balance sheet:** premiums, collateral and payouts are all MUSD; the vault share is a composable ERC-4626 token.
- **Mezo's `PriceFeed`** is the only price source, for triggers, NAV and volatility alike. It is the same feed that decides liquidations, so cover triggers on exactly the price that matters.
- **`BorrowerOperationsSignatures.repayMUSDWithSignature`**: the payout lands inside the trove without the borrower being online. The vault never owns the trove. The app and keeper dry-run that exact call (an `eth_call` from the vault) to show whether a payout will reach the trove.
- **Recovery-mode-aware liquidation line:** the app reads `TroveManager.getEntireDebtAndColl`, `getTCR` and `checkRecoveryMode`. It shows the price at which a trove really becomes liquidatable: 110%, or 150% once the whole system would fall into recovery mode first (recovery starts at `price × 150% / TCR`). It then suggests a strike just above that line and a cover that lifts the trove back to 150%.
- **Sorted-trove hints:** the keeper computes `HintHelpers.getApproxHint` + `SortedTroves.findInsertPosition` for the post-repay NICR.
- **Epochs match Mezo Earn:** weekly expiry at Thursday 00:00 UTC.
- **Smart accounts:** Mezo checks repay signatures with plain ECDSA, so smart accounts (such as Mezo Passport's Bitcoin-wallet accounts) can't pre-sign. The app detects contract accounts and pays them to the wallet instead.

## Security model

- **Fully collateralised, capped exposure.** `buy` reverts unless the cover fits `coverCapacity()`: open cover may lock at most `maxUtilization` (50%) of the vault's MUSD net of what is owed. That is the most underwriters can lose in one week. Untriggered cover is locked until expiry; triggered cover is reserved until paid (`totalOwed`).
- **NAV marks open risk.** `totalAssets = balance − owed − Σ cover × premiumRate(price, strike, time left)`, using the same function that priced the premium. Buying cover is NAV-neutral, so new depositors cannot scoop premiums and leavers cannot dodge a coming payout. The mark decays with time, so there is no expiry jump to snipe. A stale oracle marks open cover at 100% and blocks deposits.
- **Withdrawals** are capped at free liquidity. Pausing stops new sales only; it never blocks exits, triggers or claims.
- **Buyer protection:** `maxPremium` slippage bound; the app simulates every transaction before sending it and explains reverts in plain words.
- **No meta-transactions, no owner powers over funds.** The owner can only update the premium table (bounded, non-increasing), set the utilization cap (≤100%) and pause sales. Volatility comes from Mezo's feed, not from the owner. The Oct 5 veBTC exploit came through a trusted-forwarder path; Payung has none.
- **Keeper griefing:** `claim` requires 800k gas left before the repay attempt, so a keeper cannot starve the repay into the wallet fallback. Even then, the borrower still receives the MUSD.
- **Vol manipulation:** samples come only from Mezo's oracle, at ≥15 minute spacing, and each one weighs about 1% at that spacing. A floor of 35% keeps calm markets from pricing cover near zero.
- **Inflation attack:** ERC-4626 virtual shares with a 6-decimal offset.

## Tests

```bash
npm run test:contracts    # 24 unit + fuzz tests (Foundry)
npm run test:fork         # 2 fork tests: the real MUSD system on Mezo testnet
E2E_KEY=0x... npm run test:e2e   # Playwright, real wallet bridge, real testnet transactions
```

- **Unit and fuzz tests** cover pricing:
  - table values, time decay and NAV accrual through the week
  - volatility sampling, clamping and long-gap restart
  - `maxPremium`, the utilization cap and re-arming auto-repay
  - trigger and claim paths and the stale oracle
  - solvency under random drops.
- **Fork tests** open real troves and sign real EIP-712 repays, buy cover, simulate the touch and check the trove's debt fell by exactly the cover. One test makes the original signature invalid and re-arms it with `setAutoRepay`. Mezo's BTC oracle is a chain precompile the local EVM can't run, so the tests read the live price over RPC and pin `PriceFeed` to it. Every MUSD contract runs unmodified.
- **End-to-end** (`e2e/`):
  - **Wallet bridge.** The browser wallet answers EIP-1193 requests in Node with a viem account. It announces itself over EIP-6963 and starts on Ethereum mainnet without Mezo, so the add/switch-network path runs.
  - **Flow with a wallet.** The suite connects, recovers from a mid-session network change, and rejects bad input (letters, `1.2.3`, under 10 MUSD, more than the vault can back). It drives the strike slider to both ends of the 5–30% band and buys real cover with auto-repay.
  - **Re-arm on a real nonce.** It then sends a real signed 1 MUSD repay to Mezo, which uses up the nonce. The test checks that the app flags the policy and re-signs it.
  - **Underwriting and account switch.** It deposits and withdraws, and handles a wallet account switch.
  - **Read-only checks** (run in CI): no-wallet state, phone width without sideways scroll, keyboard focus, and no page errors.

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs unit, fuzz and fork tests, lint and the read-only e2e suite on every push.

## Run it

```bash
npm install
npm run dev                                   # app on http://localhost:5173
KEEPER_KEY=0x... npm run keeper               # long-running keeper: 5 s polling
node keeper/keeper.mjs --once                 # one pass (what the GitHub Actions cron runs)
node keeper/check.mjs                         # read-only: is each auto-repay still armed?
cd contracts && forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PRIVATE_KEY
```

The app reads the vault address from `shared/mezo.js` (`?vault=0x…` overrides it in `npm run dev` only, because in a shared build a link could aim MUSD approvals at any contract).

## App features

- **Wallets and network.** EIP-6963 wallet discovery (a picker when several are installed), `accountsChanged`/`chainChanged` handling, and a wrong-network banner with one-click switch or add.
- **Loan-aware defaults.** A recovery-mode-aware liquidation line and a suggested strike and cover from your trove.
- **Live pricing.** A premium quote that falls as the week runs out. It shows the on-chain volatility and the 1% slippage bound.
- **Underwriter view.** Vault value, utilization, premiums this week and free liquidity. Vault activity is decoded from the Mezo explorer's (Blockscout) log API.
- **My cover.** Per-policy auto-repay health from a dry-run of Mezo's repay, with a one-click re-sign.
- **Browser alerts.** A notification when BTC is within 3% of your strike and when cover pays out.

## Known limits

- **Touch detection** depends on someone calling `trigger` while BTC is under the strike. The hosted keeper looks every 5 minutes (a GitHub Actions limit), while `npm run keeper` polls every 5 seconds. Mezo's oracle exposes only the current price, so a dip shorter than the polling gap can be missed. Anyone can run a keeper.
- **Premium table** shape is fixed (one week, 50% vol); vol and time enter through the distance rescaling. The owner can refresh the table.
- **Mezo testnet quirks** we hit:
  - `eth_estimateGas` undershoots calls that touch the oracle precompile, so we send a fixed 3M gas limit (gas costs ~150 wei).
  - `PriceFeed.fetchPrice` occasionally reverts on an oracle timestamp underflow; the keeper retries.
  - `eth_getLogs` is limited to 10,000 blocks, so the app reads history from the explorer API.

## Roadmap

1. **Wave 2 (Nov 2–15):** multiple expiries (1 and 4 weeks) sharing one vault, and a capped mainnet vault after an external review.
2. **December:** redemption-risk cover (strike on the redemption queue position, not just price), partner vault curators.
3. **Q1 2027:** cover as a module other Mezo apps can embed at borrow time.

## Team

- _Your name_: product, contracts, app ([X](https://x.com/) · [LinkedIn](https://linkedin.com/))
