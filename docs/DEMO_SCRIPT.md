# Noxus — Demo Video Shooting Script (≤ 4 min)

> **Confidential cross-chain USDC settlement over unmodified Circle CCTP V2, with iExec Nox as the privacy layer.**
> Individual deposit amounts never touch the blockchain; one public aggregate bridges; an on-chain, TEE-verified integrity check gates confidential distribution — and makes cheating detectable, unprofitable, and self-exposing.

This is a timed shot list for the presenter. Target runtime **~3:45**. Follow the **actual built flow** (README §1 + §13, PLAN §3): depositors **pre-register their destination claim on Arbitrum** (option B, owner-binding), and the **keeper/frontend drives** `close → settle → relay → check → finalize`.

**Verified live (2026-07-12):** honest 3-depositor epoch settles ETH Sepolia → distributes Arb Sepolia with `check == 1`, zero mock data; recipient decrypts their own balance. KMS reveal RTT is fast (~2–7 s; ETH-Sep block confirmation, not KMS, is the slow part) — this is a **GO-LIVE** recording.

---

## Positioning line to say once (memorize it)
> "This is **confidentiality, not anonymity**. Participants stay visible, amounts never appear — audit-friendly by design, not a mixer."

## The one defensible superlative (say verbatim; never say "first private CCTP")
> "The **first amount-confidential CCTP settlement via TEE batching with verifiable integrity.**"

---

## Pre-flight checklist (do BEFORE hitting record)

- [ ] **Green Nox status day** — check `status.noxprotocol.io` is all-operational; run one throwaway reveal to confirm KMS RTT is in the ~2–7 s band. Do not record on a red/degraded day.
- [ ] **Both testnet accounts funded** — deployer + keeper have ETH Sepolia **and** Arb Sepolia gas (top up Sepolia ETH; the honest live run needs headroom), plus the fee-subsidy USDC buffer on both contracts. Confirm via the pre-demo check script.
- [ ] **Epoch #1 pre-run and settled** — fully complete a prior honest epoch so the on-chain history / dashboard isn't empty and so you have a fallback to narrate if the live epoch hiccups. **Record epoch #2 live.**
- [ ] **Three distinct depositor addresses** loaded with cUSDC (pre-funded once — the wrap boundary is public, so pre-fund off-camera), each ready to deposit a different hidden amount (e.g. 0.10 / 0.15 / 0.20 cUSDC → A = 0.45; or the 3.10 / 2.45 / 4.45 → 10.00 rehearsal set).
- [ ] **All contracts explorer-verified** on Etherscan (ETH Sepolia) and Arbiscan (Arb Sepolia) — judges click through, so green checkmarks must be visible.
- [ ] **Tabs pre-opened** (see "Tabs to have staged" below) and logged in / wallet connected.
- [ ] **A real, unrelated CCTP `depositForBurn` tx** located on Etherscan for the opening hook (any recent public burn — e.g. from a treasury/exchange), so amounts are plainly visible in it.
- [ ] The bridge widget open on the live run (its Track tab shows every phase with tx links); CLI scripts staged as the rehearsed instant fallback if a UI step stalls on camera.

## Tabs to have staged (left-to-right in the browser)
1. Etherscan — a real public CCTP burn (opening hook)
2. Etherscan — the three deposit txs on `NoxusBatcher` (source leg)
3. Etherscan — `NoxusBatcher` `EpochSettled` / the CCTP burn tx
4. Circle CCTP explorer / Iris status for the bridge message
5. Arbiscan — `<DISTRIBUTOR>` epoch, the integrity-check `finalizeEpoch` proof tx
6. Noxus frontend — the widget's **Track tab / final summary** (bridged amount shown only to the user)
7. Terminal — **auditor** demo via script (`grantAuditor` + auditor decrypts one amount)

> **Live addresses (hardened set — verify against `deployments/*.json` before shooting):** ETH Sep cUSDC `0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C`, Batcher `0x814a70961395218365DA5892F5de768a9Ed84E37`; Arb Sep cUSDC `0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209`, Distributor `0x410195cF6137661B066d4264515C6dc9b860ECFA`.

---

## Shot list

### 0:00 — 0:20 · Hook: every CCTP treasury move is public
- **On screen:** Tab 1 — a real CCTP `depositForBurn` tx on Etherscan, decoded input with the **amount plainly visible**; cursor circles the amount.
- **Presenter:** "Every treasury move over Circle's CCTP is public. Here's a real burn — anyone on Etherscan sees exactly how much, and when. Coinbase, Kraken, payroll processors all bridge this way, broadcasting position sizes and timing."
- **Tab:** Etherscan (public burn).

### 0:20 — 0:35 · What Noxus changes
- **On screen:** Title card — "Noxus: confidential cross-chain USDC over unmodified CCTP V2 · iExec Nox privacy layer." Small architecture strip: ETH Sepolia → CCTP V2 → Arb Sepolia.
- **Presenter:** "Noxus makes individual amounts **never exist on-chain** — while the aggregate stays fully auditable. Real, unmodified CCTP V2. iExec Nox for confidentiality. And it's confidentiality, not anonymity — not a mixer."
- **Tab:** Title card / slide.

### 0:35 — 1:15 · Three hidden-amount deposits (the core reveal)
- **On screen:** Tab 2 — three deposit txs to `NoxusBatcher` shown **side-by-side** on Etherscan. Each tx **exists** (from-address, timestamp, `Deposited` event visible), but **no amount** appears anywhere — calldata carries encrypted handles, not numbers.
- **Presenter:** "Three people deposit — 0.10, 0.15, 0.20 — but watch Etherscan. The transactions are right there, participants visible, and yet **not a single amount is on-chain**. The values are ERC-7984 encrypted handles, summed homomorphically inside the contract into one encrypted total."
- **Note:** Also show — in one line — that each depositor **pre-registers their destination claim on Arbitrum** (option B): "Each depositor also registers an encrypted claim on the destination chain in their own transaction — that's what lets us verify integrity later."
- **Tab:** Etherscan (3 deposits, side-by-side).

### 1:15 — 1:35 · Close → settle → the ONE public number
- **On screen:** the widget's Track tab: the **Close** and **Settle + CCTP burn** phases complete on their own (the widget drives them). Show the settle detail resolving to a single plaintext `A`, then the `EpochSettled` / CCTP burn tx on Etherscan (Tab 3) showing `A` as the only visible amount.
- **Presenter:** "The keeper closes the epoch and settles. The **only** number that ever becomes public is the aggregate — one figure, unavoidable, because that's the CCTP burn amount. No individual amount, ever."
- **Editing note:** the settle reveal is a two-tx KMS round-trip. It's fast (~2–7 s) but if the wait is visible on camera, **cut on the click and resume on the green proof indicator** — do not sit on dead air.
- **Tab:** Widget (Track tab) → Etherscan (`EpochSettled` / burn).

### 1:35 — 2:05 · Live CCTP bridge
- **On screen:** Tab 4 — Circle CCTP explorer / Iris picks up the burn; status `pending_confirmations → complete`; Fast Transfer.
- **Presenter:** "That aggregate bridges over **real** CCTP V2 Fast Transfer, carrying a hookData commitment that binds this batch to the destination claims. No fork, no modification — we call Circle's official contracts."
- **Editing note:** Fast Transfer is ~8–20 s. If it runs long on the day, **cut and resume on `complete`**; keep an on-screen timestamp so the flow reads as continuous and real.
- **Tab:** Circle CCTP explorer / Iris.

### 2:05 — 2:35 · Integrity check — the TEE-verified proof tx
- **On screen:** Tab 5 — Arbiscan on `<DISTRIBUTOR>`: the mint lands, claims are ingested, then the **integrity-check proof transaction** (`finalizeEpoch`) with the on-chain result `check == 1`. Highlight the KMS decryption proof being verified on-chain.
- **Presenter:** "On Arbitrum, an on-chain, **TEE-verified integrity check** compares the sum of everyone's destination claims against the bridged aggregate. Here it equals the aggregate — `check` is one — so distribution is authorized. This gate is what makes the whole thing safe."
- **Tab:** Arbiscan (`finalizeEpoch` proof tx).

### 2:35 — 3:00 · Confidential distribution + recipient decrypts own balance
- **On screen:** Tab 6 — the widget's final summary: "Bridged confidentially", the user's own amount (visible only in their browser), and the four tx links. On Arbiscan, the distribution tx shows **no amounts**.
- **Presenter:** "Distribution is confidential — each recipient is credited, amounts hidden from everyone. Only the recipient, in their own browser, sees their amount. Everyone else sees participants but no numbers."
- **Tab:** Frontend (Track tab final summary).

### 3:00 — 3:25 · The auditor moment
- **On screen:** Tab 7 — terminal: the depositor **grants a viewer** (`grantAuditor` via script) to an auditor address; the auditor then **decrypts exactly one amount**.
- **Presenter:** "Private for the market, transparent for whoever has the right to know. A depositor grants an auditor a viewer key, and the auditor can decrypt that one amount — selective disclosure, on-chain and on demand."
- **Accuracy note (IMPORTANT):** grants are **add-only** — do **not** claim the grant is revocable or show a "revoke" step. Say "grant a viewer," not "grant and revoke."
- **Tab:** Terminal (auditor script).

### 3:25 — 3:40 · Adversarial / fallback one-liner
- **On screen:** A single explainer card or a pre-captured `check == 0` result: inflated destination claim → integrity check fails → refund-to-source.
- **Presenter:** "And if someone cheats — inflates their destination claim — the check comes back **zero**, distribution is blocked, and an opt-in attribution reveal plus a refund back to source makes everyone whole at their attested amount. Cheating is detectable, unprofitable, and self-exposing."
- **Note:** the honest path is live; the adversarial path is built and deployed. Present this as the designed safety property, using a card or a captured result — do not imply a second full live run in the same take.
- **Tab:** Explainer card (or captured `check == 0`).

### 3:40 — 3:45 · Close: repo + tag
- **On screen:** Repo link `[REPO_LINK]` and `@iEx_ec`, with the claim line on screen.
- **Presenter:** "Noxus — the first amount-confidential CCTP settlement via TEE batching with verifiable integrity. Repo's linked. Thanks, **@iEx_ec**."
- **Tab:** End card (repo + tag).

---

## Editing cheat-sheet (where cuts are allowed)
- **Any KMS reveal wait** (settle at ~1:25, client-decrypt at ~2:40, auditor decrypt at ~3:10): cut on the click, resume on the green proof / revealed value. Keep an on-screen timestamp so the run reads as continuous and real.
- **The CCTP Fast Transfer wait** (~1:45): cut on burn, resume on Iris `complete`.
- **Never** cut in a way that hides the fact that these are real on-chain txs — keep every explorer link and every proof indicator visible; the whole pitch is "zero mock data."
- If a live UI button stalls on camera, fall back to the rehearsed CLI script for that one step and keep going; do not restart the take.
