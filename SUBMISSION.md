# AKINDO submission: Payung (Wave 1)

**Project name:** Payung

**Category:** Liquidation insurance, MUSD yield, borrowing

**TL;DR:** Payung lets Mezo borrowers buy one-to-four-week liquidation cover in MUSD that pays straight into their trove when BTC falls, funded by an MUSD underwriting vault that earns the premiums.

**How it works:**
Mezo's promise is "live off your Bitcoin without selling it", and liquidation is the one thing that breaks it. Today borrowers can only watch the price or borrow less. Payung sells them protection. A borrower picks a strike just above their liquidation price and a cover amount. If Mezo's PriceFeed touches the strike before Thursday 00:00 UTC (the Mezo Earn epoch), anyone can trigger it and earn 0.1% of the cover, and the cover is paid through Mezo's `repayMUSDWithSignature`, which repays the trove the borrower pre-signed for, without them being online. Premiums scale with time left in the week and with BTC volatility that the contract measures itself from Mezo's PriceFeed, so there is no external oracle and no owner input. The app reads Mezo's TCR and recovery mode to show the price where a trove really gets liquidated. It dry-runs the repay so borrowers can see whether their payout will reach the trove, and re-sign if another Mezo action used up their nonce. Underwriters deposit MUSD into an ERC-4626 vault that fully backs every policy, caps open cover at 50% of the vault (the most it can lose in a week), and earns the premiums: a new MUSD yield source with its own risk profile. MUSD is the whole balance sheet (premium, collateral, payout). The trigger uses the same Mezo PriceFeed that decides liquidations.

**Target group:** Mezo MUSD borrowers who keep BTC long-term and fear a sharp drop (desktop and mobile web, intermediate DeFi users), and MUSD holders who want yield that isn't tied to LP or Stability Pool risk. Track 1: makes MUSD productive capital, and makes Mezo Borrow safer to use at higher LTV.

**Tech stack:** Solidity 0.8.24, Foundry (32 unit/fuzz tests, 5 invariants over 128k random calls, 3 fork tests against the live MUSD contracts, one of them a claim-griefing sweep), Slither (0 findings), node:test unit tests for the payout decision, axe-core, OpenZeppelin ERC-4626, viem, Mezo Pools router (BTC → MUSD for the premium), React + Vite, EIP-6963 wallets, Mezo Passport Bitcoin wallets (OrangeKit smart accounts, with Payung's own relayer as a Vercel Function), Playwright e2e with a real wallet bridge on testnet and BTC-touch tests on an anvil fork of Mezo (through the app, and the keeper alone), archive reads for share-price history, Node keeper on a GitHub Actions cron, Blockscout API.

**Track:** Track 1 (DeFi)

**Chain:** Mezo testnet (31611)

**Project status:** Entirely new, built during Wave 1.

**Readiness:** Testnet deployment. Vault v2 `0x706B5E6F3760eb0c5fe4c726784FbFB269Ac4150` (Sourcify-verified) is live with the claim-griefing fix found in our own review (a fork test against the real MUSD contracts showed a caller could starve an auto-repay into a wallet payout). v1 `0xdC66559C75c9950f8869e20A04C14494DF601d4d` (Sourcify-verified) holds the earlier history: deposits, cover purchases, and an auto-repay re-signed after a real nonce change; the keeper still pays its cover. A keeper runs every 5 minutes on GitHub Actions, and CI runs on every push.

**Future milestones:**
1. Wave 2 (Nov 2–15): capped mainnet vault after an external review. a relayer with per-user rate limits and a gas budget (Bitcoin wallets already buy cover through Mezo Passport today, via Payung's own relayer).
2. December 2026: partner vault curators; redemption-risk cover only with a trigger that can't be gamed (a queue-position trigger can be moved with throwaway loans, so today it is a warning plus phone alert).
3. Q1 2027: cover as an embeddable module offered at borrow time in other Mezo apps.

**Team:** Pugar Huda Mantoro, solo builder (product, contracts, app). X: [@bangdropid](https://x.com/bangdropid) · LinkedIn: [pugar-huda-mantoro](https://www.linkedin.com/in/pugar-huda-mantoro) · GitHub: [PugarHuda](https://github.com/PugarHuda)

**Links:** GitHub https://github.com/PugarHuda/payung · Live app https://payung-ecru.vercel.app · Video https://payung-ecru.vercel.app/payung-demo.mp4 (72 s screen recording of the live app on Mezo testnet, recorded by `scripts/record-demo.mjs`) · Deck https://claude.ai/artifact/1rMGP1CG9omkKeZYzJ6m51

---

## 2-minute video script

| Time | On screen | Voice |
|---|---|---|
| 0:00–0:15 | Mezo borrow page, trove at 134% | "Mezo lets you borrow against Bitcoin without selling it. But if BTC drops 18%, this loan is liquidated and the Bitcoin is gone." |
| 0:15–0:30 | Payung Protect tab, the price shaft | "Payung is an umbrella for that loan. BTC now, your liquidation line in red, and the umbrella: the price where your cover pays out." |
| 0:30–0:55 | Drag strike, cover auto-filled, sign repay, buy | "Payung reads my loan and Mezo's recovery mode, then suggests a strike just above liquidation and a cover that lifts me back to 150%. The premium comes from BTC volatility the contract measures itself. I sign Mezo's repay message once and buy." |
| 0:55–1:20 | Fork test output, trove debt before/after | "If BTC touches the strike, anyone can trigger it. The cover goes straight into the trove through Mezo's own repay-with-signature. Here it is against the real MUSD contracts: debt down by exactly the cover." |
| 1:20–1:40 | Underwrite tab, activity feed, My cover "repay checked" | "The cover is funded by MUSD holders. They earn the premiums, every policy is fully backed, and at most half the vault is at risk in a week. My cover shows a live dry-run of the payout into the loan." |
| 1:40–2:00 | Explorer: verified contract, txs | "Live on Mezo testnet and verified. Next: vol-based pricing and a mainnet vault. Payung: keep your Bitcoin dry." |
