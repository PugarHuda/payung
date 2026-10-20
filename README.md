# Payung

**Liquidation cover for Mezo MUSD borrowers.** *Payung* is Indonesian for umbrella.

Mezo lets you live off your Bitcoin without selling it: lock BTC, borrow MUSD. The one thing that can take your BTC away is a price drop to the 110% liquidation line. Today a borrower's only defences are watching the price or borrowing less. Payung lets them **buy protection** instead.

- **Borrowers** pay a small weekly premium in MUSD. If the Mezo BTC price touches their strike before Thursday 00:00 UTC (the Mezo Earn epoch boundary), Payung pays a fixed MUSD amount **straight into their trove** through Mezo's own `repayMUSDWithSignature`, lifting the collateral ratio before liquidation.
- **Underwriters** deposit MUSD into an ERC-4626 vault (`pyMUSD`) and earn the premiums. It is a new MUSD yield source with its own risk profile, uncorrelated with Stability Pool liquidations or LP fees.

Built for the [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10), Track 1 (DeFi).

## Live on Mezo testnet (chain 31611)

| | |
|---|---|
| App | https://pugarhuda.github.io/payung/ |
| Payung vault | [`0x5eFFEe5B8b817E7A1B785C1a97487C6394cb6b87`](https://explorer.test.mezo.org/address/0x5eFFEe5B8b817E7A1B785C1a97487C6394cb6b87), Sourcify `exact_match` |
| Underwriter deposit (1,500 MUSD) | [`0x2e3ca471…4eb0`](https://explorer.test.mezo.org/tx/0x2e3ca471ad69901e286386dccfca792acd8e5082d56e8c0482ce31f68e2b4eb0) |
| Cover bought with pre-signed auto-repay (500 MUSD at $72,000, premium 38.5 MUSD) | [`0x3d312134…1367`](https://explorer.test.mezo.org/tx/0x3d31213410763b48178c20361bebc1e0a3562e3303aabbe4b5ec7b2edb6d1367) |
| Touch → trigger → repay into a real trove | Fork test against the live MUSD contracts (see below); a real touch on testnet needs BTC to actually fall 12% |

## How it works

```
underwriters ──MUSD──▶ Payung vault (ERC-4626) ◀──premium── borrower
                          │  fully backs every policy
                          │
   Mezo PriceFeed ──▶ trigger(strike)   permissionless, once price ≤ strike
                          │
                      claim(policy)     permissionless (keeper)
                          ├─ repayMUSDWithSignature(cover, borrower, sig) ──▶ borrower's trove
                          └─ fallback: MUSD to the borrower's wallet
```

1. **Buy.** `buy(strike, cover, autoRepay, sigDeadline, signature)`. Strikes sit on a $1,000 grid, 5% to 30% below spot. Premium = cover × touch probability from a one-week table (50% vol, 1.25× margin), linearly interpolated per basis point. With `autoRepay`, the borrower signs Mezo's `RepayMUSD(amount, borrower, nonce, deadline)` once in the app.
2. **Touch.** Anyone calls `trigger(strike)` when `PriceFeed.fetchPrice() <= strike` before expiry. One-touch, not European: cover pays when the danger happens, not on Thursday.
3. **Pay.** Anyone calls `claim(id, hints)`. Mezo verifies the borrower's signature and burns the vault's MUSD against the trove debt. If the signature was voided (the borrower signed another Mezo action), the trove is closed, or the repay would break the 1,800 MUSD minimum debt, the MUSD goes to the borrower's wallet instead.
4. **Expire.** Untriggered cover lapses at Thursday 00:00 UTC; the locked MUSD and premiums stay with underwriters.

## Why it is deep on Mezo

- **MUSD is the whole balance sheet:** premiums, collateral and payouts are all MUSD; the vault share is a composable ERC-4626 token.
- **Mezo's `PriceFeed`** is the only price source, the same feed that decides liquidations, so cover triggers on exactly the price that matters.
- **`BorrowerOperationsSignatures.repayMUSDWithSignature`**: the payout lands inside the trove without the borrower being online. The vault never owns the trove.
- **Trove-aware UX:** the app reads `TroveManager.getEntireDebtAndColl`, shows the liquidation price, and suggests a strike just above it and a cover that lifts the trove back to 150%.
- **Epochs match Mezo Earn:** weekly expiry at Thursday 00:00 UTC.

## Security model

- **Fully collateralised.** `buy` reverts unless free liquidity covers the new policy. Untriggered cover is locked until expiry; triggered cover is reserved until paid (`totalOwed`).
- **NAV marks open risk.** `totalAssets = balance − owed − Σ cover × touchProbability(distance)`, using the same table that priced the premium. Buying cover is NAV-neutral, so new depositors cannot scoop premiums and leavers cannot dodge a coming payout. A stale oracle marks open cover at 100% and blocks deposits.
- **Withdrawals** are capped at free liquidity; pausing stops new sales only, never exits, triggers or claims.
- **No meta-transactions, no owner powers over funds.** The owner can only update the premium table (bounded, non-increasing) and pause sales. The Oct 5 veBTC exploit came through a trusted-forwarder path; Payung has none.
- **Keeper griefing:** `claim` requires 800k gas left before the repay attempt, so a keeper cannot starve the repay into the wallet fallback.
- **Inflation attack:** ERC-4626 virtual shares with a 6-decimal offset.

## Tests

```bash
cd contracts
forge test --no-match-contract Fork                                              # 17 unit + fuzz tests
forge test --match-contract PayungFork --fork-url https://rpc.test.mezo.org     # real MUSD system
```

The fork test opens a real trove, signs a real EIP-712 repay, buys cover, simulates the touch and checks the trove's debt fell by exactly the cover. Mezo's BTC oracle is a chain precompile the local EVM can't run, so the test reads the live price over RPC and pins `PriceFeed` to it. Every MUSD contract runs unmodified.

## Run it

```bash
npm install
npm run dev                                   # app on http://localhost:5173
KEEPER_KEY=0x... npm run keeper               # triggers touched strikes, pays policies
cd contracts && forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PRIVATE_KEY
```

The app reads the vault address from `shared/mezo.js` (`?vault=0x…` overrides it in `npm run dev` only).

## Known limits (deliberate, Wave 1)

- **Premium table, not a vol oracle.** One fixed one-week table, refreshed by the owner. Wave 2: on-chain barrier pricing from a realised-vol feed.
- **Full collateral** keeps capital efficiency at 1:1. Wave 2: exposure caps per strike with partial collateral.
- **Mezo testnet quirks** we hit: `eth_estimateGas` undershoots calls that touch the oracle precompile (we send a fixed 3M gas limit; gas costs ~150 wei), and `PriceFeed.fetchPrice` occasionally reverts on an oracle timestamp underflow (the keeper retries).

## Roadmap

1. **Wave 2 (Nov 2–15):** vol-driven pricing, multiple expiries (1 and 4 weeks), Telegram alerts when a strike is close, mainnet deploy with a capped vault.
2. **December:** redemption-risk cover (strike on the redemption queue position, not just price), partner vault curators.
3. **Q1 2027:** cover as a module other Mezo apps can embed at borrow time.

## Team

- _Your name_: product, contracts, app ([X](https://x.com/) · [LinkedIn](https://linkedin.com/))
