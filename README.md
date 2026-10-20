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
| Payung vault | [`0x7F9f315304450d5E78475223374545B8B9b873A0`](https://explorer.test.mezo.org/address/0x7F9f315304450d5E78475223374545B8B9b873A0), Sourcify `exact_match` |
| Underwriter deposit (1,000 MUSD) | [`0x74e5516c…80e4`](https://explorer.test.mezo.org/tx/0x74e5516c281fd9141b8b6a1819e5c6a5d2cb2dde3ada9990af6f40b8b24380e4) |
| Cover with pre-signed auto-repay (300 MUSD at $71,000, ~40 h left, premium 0.75 MUSD) | [`0x8d4499db…f97b`](https://explorer.test.mezo.org/tx/0x8d4499db70caa97f7c582b9f6903c6043c60754c7620f76dbea15749518af97b) |
| Cover bought through the app by the e2e test | [`0x355d2ff5…6ea1`](https://explorer.test.mezo.org/tx/0x355d2ff5ad47dce79ff5d17272936d94316408523674e023071c1e6260556ea1) |
| Auto-repay re-signed after a real Mezo nonce was used up | [`0x4c26800c…a9f0`](https://explorer.test.mezo.org/tx/0x4c26800cfb70f1b9ddb974046b5db530081083d794a23b7761721989314ea9f0) |
| Keeper | GitHub Actions every 5 minutes, each run watching for 270 s at 10 s polls ([runs](https://github.com/PugarHuda/payung/actions/workflows/keeper.yml)), dedicated wallet `0x4FF8d702D8CC8c106BB1C7C6Bf56459DE4300d9D` |
| Touch → trigger (reward) → repay into a real trove | Foundry fork tests, and a Playwright test that clicks through it in the app on an anvil fork of Mezo testnet (see Tests); a real touch on testnet needs BTC to actually fall 5%+ |

## How it works

```
underwriters ──MUSD──▶ Payung vault (ERC-4626) ◀──premium── borrower
                          │  backs every policy, open cover ≤ 50% of the vault
   Mezo PriceFeed ──▶ poke()             permissionless: on-chain BTC volatility
                  ──▶ trigger(strike)    permissionless, once price ≤ strike; caller earns 0.1%
                          │
                      claim(policy)      permissionless (keeper)
                          ├─ repayMUSDWithSignature(cover, borrower, sig) ──▶ borrower's trove
                          └─ fallback: MUSD to the borrower's wallet
```

1. **Buy.** `buy(strike, cover, maxPremium, autoRepay, sigDeadline, signature)`. Strikes sit on a $1,000 grid, 5% to 30% below spot. With `autoRepay`, the borrower signs Mezo's `RepayMUSD(amount, borrower, nonce, deadline)` once in the app. `maxPremium` protects the buyer if BTC moves between quote and execution.
2. **Price.** A one-touch probability depends on distance / (volatility × √time). Payung rescales the strike distance by `(50% / vol) × √(week / time left)` and reads a one-week, 50%-vol table (1.25× margin). So cover gets cheaper as the week runs out, and dearer when BTC is volatile.
3. **Volatility from Mezo itself.** `poke()` samples Mezo's PriceFeed (every 15 minutes or more; buys and triggers sample too) into an EWMA of annualised variance with a one-day time constant, clamped to 35–200%. Gaps over a day restart sampling instead of producing one huge sample. No external vol oracle and no owner input.
4. **Touch.** Anyone calls `trigger(strike)` when `PriceFeed.fetchPrice() <= strike` before expiry, and earns 0.1% of the touched cover (max 10 MUSD). Mezo's oracle keeps no price history (`getRoundData` is not supported), so a touch only counts if someone is watching. The reward pays outside bots to watch, and the app shows a **Trigger it and earn** button to any visitor while a strike is touched. One-touch, not European: cover pays when the danger happens, not on Thursday.
5. **Pay.** Anyone calls `claim(id, hints)`; holders have a **Pay out now** button, so nobody has to wait for a keeper. Mezo verifies the borrower's signature and burns the vault's MUSD against the trove debt. If the repay would fail, the MUSD goes to the borrower's wallet instead. That happens when the signature was voided, the trove is closed, or the repay would break the 1,800 MUSD minimum debt.
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
- **NAV marks open risk.** `totalAssets = balance − owed − Σ cover × premiumRate(price, strike, time left)` (a touched strike counts in full, including its trigger reward), using the same function that priced the premium. Buying cover is NAV-neutral, so new depositors cannot scoop premiums and leavers cannot dodge a coming payout. The mark decays with time, so there is no expiry jump to snipe. A stale oracle marks open cover at 100% and blocks deposits.
- **Withdrawals** are capped at free liquidity. Pausing stops new sales only; it never blocks exits, triggers or claims.
- **Buyer protection:** `maxPremium` slippage bound; the app simulates every transaction before sending it and explains reverts in plain words.
- **No meta-transactions, no owner powers over funds.** The owner can only update the premium table (bounded, non-increasing), set the utilization cap (≤100%) and pause sales. Volatility comes from Mezo's feed, not from the owner. The Oct 5 veBTC exploit came through a trusted-forwarder path; Payung has none.
- **Keeper griefing:** `claim` requires 800k gas left before the repay attempt, so a keeper cannot starve the repay into the wallet fallback. Even then, the borrower still receives the MUSD.
- **Vol manipulation:** samples come only from Mezo's oracle, at ≥15 minute spacing, and each one weighs about 1% at that spacing. A floor of 35% keeps calm markets from pricing cover near zero.
- **Inflation attack:** ERC-4626 virtual shares with a 6-decimal offset.

## Tests

```bash
npm run test:contracts    # 25 unit + fuzz tests, 5 invariants over 128,000 random calls (Foundry)
npm run test:fork         # 2 fork tests: the real MUSD system on Mezo testnet
E2E_KEY=0x... npm run test:e2e   # Playwright: real wallet bridge, real testnet transactions, anvil-fork touch
cd contracts && slither src/Payung.sol --config-file slither.config.json   # static analysis: 0 findings
```

- **Invariant tests** (`PayungInvariant.t.sol`) drive the vault through random sequences of deposits, withdrawals, buys (with and without auto-repay), price moves, triggers, claims (repay accepted or refused), vol samples and time jumps. `fail_on_revert` is on, and a valid buy that reverts fails the run. After each sequence:
  - MUSD always covers what is owed;
  - live open cover is fully backed on top of that;
  - NAV never counts owed or at-risk MUSD;
  - `totalOwed` equals the unpaid touched policies, recomputed from scratch;
  - volatility stays inside its clamp.
- **Slither** runs in CI. The few warnings left are reviewed and annotated inline: interpolation modulo, the oracle freshness call, and the expiry guard. One real finding was fixed: the vol sample now rounds once instead of twice.

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
  - **A real touch, through the UI** (`e2e/touch.spec.mjs`). It runs an anvil fork of Mezo testnet holding the deployed vault and the real MUSD system, and swaps only `PriceFeed`'s code for one that returns a set price, because anvil can't run Mezo's oracle precompile. The test sets BTC $500 under the policy's strike. It re-signs auto-repay if a past Mezo action used up the nonce. Then it clicks **Trigger it and earn** and checks the caller received exactly the reward. Finally it clicks **Pay out now** and checks the trove's debt fell by the cover.
  - **Read-only checks** (run in CI): no-wallet state, phone width without sideways scroll, keyboard focus, an axe-core WCAG 2.1 AA audit of every tab (0 violations), and no page errors.

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs unit, fuzz, invariant and fork tests, Slither, lint and the read-only e2e suite on every push.

The tests found and fixed real bugs:
- Refreshes stacked up on a slow RPC, and one transaction could leave the UI stuck on "Withdrawing…".
- A payout that fell back to the wallet was reported as "into your loan". The message now comes from the `PolicyPaid` event.
- The raw viem error showed for a wallet out of gas money.
- Secondary text failed the WCAG contrast minimum.

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
- **My cover.** Per-policy auto-repay health from a dry-run of Mezo's repay, with a one-click re-sign and **Pay out now** for touched cover.
- **Anyone can keep.** Touched strikes show a **Trigger it and earn** button with the reward. The underwriter view shows when the price was last sampled, so a stalled keeper is visible.
- **Payout preview.** The Protect tab shows your collateral ratio at the strike, before and after the payout.
- **Browser alerts.** A notification when BTC is within 3% of your strike and when cover pays out.

## Known limits

- **Touch detection** depends on someone calling `trigger` while BTC is under the strike. Mezo's oracle exposes only the latest round, and the Pyth contract on Mezo testnet holds a months-old BTC price whose Hermes history API now needs a key, so a past dip can't be proven on-chain. The hosted keeper polls every 10 s inside runs that GitHub starts every 5 minutes (GitHub may delay them), and `npm run keeper` polls every 5 s. The trigger reward exists so outside bots watch too.
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
