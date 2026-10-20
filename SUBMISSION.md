# AKINDO submission: Payung (Wave 1)

**Project name:** Payung

**Category:** Liquidation insurance, MUSD yield, borrowing

**TL;DR:** Payung lets Mezo borrowers buy weekly liquidation cover in MUSD that pays straight into their trove when BTC falls, funded by an MUSD underwriting vault that earns the premiums.

**How it works:**
Mezo's promise is "live off your Bitcoin without selling it", and liquidation is the one thing that breaks it. Today borrowers can only watch the price or borrow less. Payung sells them protection. A borrower picks a strike just above their liquidation price and a cover amount. If Mezo's PriceFeed touches the strike before Thursday 00:00 UTC (the Mezo Earn epoch), anyone can trigger it, and the cover is paid through Mezo's `repayMUSDWithSignature`, which repays the trove the borrower pre-signed for, without them being online. Underwriters deposit MUSD into an ERC-4626 vault that fully backs every policy and earns the premiums: a new MUSD yield source with its own risk profile. MUSD is the whole balance sheet (premium, collateral, payout). The trigger uses the same Mezo PriceFeed that decides liquidations.

**Target group:** Mezo MUSD borrowers who keep BTC long-term and fear a sharp drop (desktop and mobile web, intermediate DeFi users), and MUSD holders who want yield that isn't tied to LP or Stability Pool risk. Track 1: makes MUSD productive capital, and makes Mezo Borrow safer to use at higher LTV.

**Tech stack:** Solidity 0.8.24, Foundry (unit, fuzz and fork tests against the live MUSD contracts), OpenZeppelin ERC-4626, viem, React + Vite, Node keeper.

**Track:** Track 1 (DeFi)

**Chain:** Mezo testnet (31611)

**Project status:** Entirely new, built during Wave 1.

**Readiness:** Testnet deployment. Vault `0x5eFFEe5B8b817E7A1B785C1a97487C6394cb6b87` (Sourcify-verified), with on-chain deposit and cover purchase.

**Future milestones:**
1. Wave 2 (Nov 2–15): vol-driven pricing, 1- and 4-week expiries, Telegram alerts near the strike, capped mainnet vault.
2. December 2026: redemption-risk cover (redemption queue position as the trigger), partner vault curators.
3. Q1 2027: cover as an embeddable module offered at borrow time in other Mezo apps.

**Team:** _name, role, X/LinkedIn_

**Links:** GitHub _repo URL_ · Live app _URL_ · Video _URL_ · Deck _URL_

---

## 2-minute video script

| Time | On screen | Voice |
|---|---|---|
| 0:00–0:15 | Mezo borrow page, trove at 134% | "Mezo lets you borrow against Bitcoin without selling it. But if BTC drops 18%, this loan is liquidated and the Bitcoin is gone." |
| 0:15–0:30 | Payung Protect tab, the price shaft | "Payung is an umbrella for that loan. BTC now, your liquidation line in red, and the umbrella: the price where your cover pays out." |
| 0:30–0:55 | Drag strike, cover auto-filled, sign repay, buy | "Payung suggests a strike just above liquidation and a cover that lifts you back to 150%. I sign Mezo's repay message once and pay 38 MUSD for this week." |
| 0:55–1:20 | Fork test output, trove debt before/after | "If BTC touches the strike, anyone can trigger it. The cover goes straight into the trove through Mezo's own repay-with-signature. Here it is against the real MUSD contracts: debt down by exactly the cover." |
| 1:20–1:40 | Underwrite tab | "The cover is funded by MUSD holders. They earn the premiums, and every policy is fully backed. That's a new MUSD yield source." |
| 1:40–2:00 | Explorer: verified contract, txs | "Live on Mezo testnet and verified. Next: vol-based pricing and a mainnet vault. Payung: keep your Bitcoin dry." |
