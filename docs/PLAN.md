# Noxus — Implementation Plan (planning session S3, 2026-07-12)

## Context

Noxus ships confidential cross-chain USDC settlement over unmodified Circle CCTP V2, using iExec Nox as the privacy layer: encrypted deposits batch on ETH Sepolia, one public aggregate bridges to Arbitrum Sepolia, and a TEE-verified integrity check gates confidential distribution. Judging bar: deployed per the brief, end-to-end with zero mock data, ≤4-min video, `feedback.md`, ≤3 weeks. The repo today contains only the spec (`README_NOXUS.md`); no code, no `package.json`. This plan turns §12's build order into executable phases, resolves both contracts to signature/state-machine level, and front-loads a Day-0 GO/NO-GO gate.

This session: primary-source verification burned down most §7.6 unknowns (§1 below); the design was then adversarially reviewed by three independent critics and revised (opt-in fallback reveal, deposit-withdrawal healing, revised latency tiers, expiration handling). Nothing modifies CCTP or Nox (G1); every address carries provenance or a re-verification task (G2); `allowPublicDecryption` appears at exactly 3 authored sites (G3); no implementation code was written.

**User decisions recorded (asked 2026-07-12):** frontend = port of an earlier hackathon UI (team page keeps only the Aiden card) · keeper fully driven/visible via frontend with on-screen proof · demo amounts 3.10/2.45/4.45 → A = 10.00 · keep spec names + rename `README_NOXUS.md` → `README.md` at commit #1.

---

## 1. Verification results feeding this plan (2026-07-12, this session)

Re-confirmed from vendored/installed source at execution time before first use (G2/G10).

**Circle CCTP V2 (all verified-primary):**
| Fact | Value | Source |
|---|---|---|
| TokenMessengerV2 testnet (BOTH chains — CREATE2-identical) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | developers.circle.com/cctp/evm-smart-contracts |
| MessageTransmitterV2 testnet (BOTH chains) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | same |
|  **Correction**: README §5's `0x81D4…4B64` | is the **MAINNET** transmitter (Etherscan-labeled) — never use on testnet | Etherscan cross-check |
| USDC testnet | ETH Sep `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` · Arb Sep `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | usdc-contract-addresses page |
| `depositForBurnWithHook` signature | matches README §5 exactly | TokenMessengerV2.sol (master) |
| **Correction**: BurnMessageV2 offsets | maxFee@132, **feeExecuted@164, expirationBlock@196** (README §5 has these two swapped), hookData@228; outer MessageV2 header = 148 B (nonce bytes32@12, destinationCaller@108, messageBody@148) | BurnMessageV2.sol + MessageV2.sol + docs |
| maxMessageBodySize | 8192 B ⇒ hookData budget ≈ **7964 B** (re-verify via on-chain getter on BOTH chains Day-0 — the SEND-side ETH Sepolia value is what binds) | DeployProxiesV2.s.sol |
| Hook execution model | Circle **never executes hooks** ("opaque metadata … execution left entirely to the integrator"). Official sample `src/examples/CCTPHookWrapper.sol`: wrapper calls `receiveMessage` then parses hookData itself. `destinationCaller`, if set, is the only address that may call `receiveMessage` | cctp/references/technical-guide + sample |
| No npm package for CCTP contracts | vendor interfaces/offsets from `github.com/circlefin/evm-cctp-contracts` master (`src/v2/`, `src/messages/v2/`), commit hash cited in file headers | npm registry 404 |
| Fees / Iris | `GET iris-api-sandbox.circle.com/v2/burn/USDC/fees/{src}/{dst}` (bps, never hardcode; maxFee = bps × amount); `/v2/messages/{srcDomain}?transactionHash=…` status `pending_confirmations → complete`; Fast = threshold ≤ 1000, attestation ~8 s (→Arb) / ~20 s (→ETH) | api-reference pages |
| Faucet | 20 USDC per 2 h per address per chain | faucet.circle.com |

**iExec Nox (all verified-primary from npm registry + GitHub `iExec-Nox` + docs):**
| Fact | Value |
|---|---|
| Packages pinned | `@iexec-nox/handle@0.1.0-beta.13` · `@iexec-nox/nox-protocol-contracts@0.2.4` · **`@iexec-nox/nox-confidential-contracts@0.2.2`** (the previously-unknown ERC-7984 pkg) · `nox-hardhat-plugin@0.1.0` exists but treat as template |
| Infra health (2026-07-12) | status.noxprotocol.io all-operational; gateway health endpoint live |
| Wrapper semantics | `wrap(address to, uint256 amount) returns (euint256)` (plaintext in) · `unwrap(address from, address to, euint256 amount) returns (euint256)` requires `Nox.isAllowed(amount, msg.sender)` · `_unwrap` **burns to a FRESH handle and calls `allowPublicDecryption` on it itself** · `finalizeUnwrap(euint256 unwrapRequestId, bytes decryptedAmountAndProof)` verifies against that fresh handle |
| `confidentialTransferFrom` | returns `euint256 transferred = select(success, amount, 0)` — actual amount or **encrypted zero** (never partial) |
| `fromExternal` failure semantics | **synchronous on-chain revert** (proof = 137 B; EIP-712 `HandleProof(handle,owner,app,createdAt)` gateway-signed; checks incl. `appInProof == msg.sender`, `ownerInProof == owner`) — no async poisoning |
| Nox.sol API | §6 confirmed; adds `safeSub/safeMul/safeDiv`, `isAllowed`, `isInitialized`. **No `and(ebool,ebool)`** — fold booleans via `select` (construction in §3.2) |
| Handle layout | chainId at bytes **[1-4]** in latest package AND current docs — README §7.1's "docs say [26-29]" has no live source |
| NoxCompute addresses | §5 values confirmed (docs repo + live `eth_getCode`, UUPS proxies) |

**Hackathon logistics:** no official "iExec WTF (Summer)" page found (DoraHacks/TAIKAI/Devpost, 2026-07-12). Both verified predecessors (Hack4Privacy, Vibe Coding) required deployment on **"Sepolia Arbitrum or Arbitrum"** — not ETH Sepolia — plus feedback.md, ≤5 teams, 4-min video, no-mock wording. Discord Q1 (Phase 0) is the top open item; its wording covers both directions.

**README amendments queued (quoted, flagged — not silently resolved).** Safety-relevant §5 corrections land at **Phase 0a commit #1** (leaving a known-wrong mainnet address labeled "Arb Sepolia" in the G2 address registry for 3 weeks is unacceptable); prose amendments land Phase 7:
- §5: strike/relabel `0x81D4…4B64` as MAINNET-do-not-use; add pinned testnet addresses w/ provenance; fix swapped `feeExecuted`/`expirationBlock` offsets; amend "destinationCaller = bytes32(0) ⇒ anyone relays" → we set destinationCaller = Distributor to preserve hook atomicity, relay stays permissionless one level up (D-011, §3.5)
- §4: "`interfaces/ITokenMessengerV2,IMessageHandlerV2`" → `IMessageTransmitterV2` (Circle executes no callback — there is no handler interface to implement)
- §1 mermaid: "mint A + hook callback" and "wrap A → cUSDC" at hook receipt → relay model + deferred wrap (§3.2); fallback lane → D-010
- §2: "honest users lose privacy for that epoch only" → under D-010, honest amounts stay private unless the holder opts to self-exculpate
- §3 prose + §7.5: fallback flow per D-010; codify grep scope ("exactly 3 in authored `contracts/**`; official wrapper's internal reveal excluded — it reveals only the already-public aggregate")
- §7.1: drop the "[26-29]" layout note (no live source)

---

## 2. Phases

Timeline anchors: **W1** Jul 12–18 (Phases 0–2) · **W2** Jul 19–26 (Phases 3–5 — the README's "W2 slack" is hereby explicitly converted into the pre-committed trim order + float days) · **W3** Jul 26–Aug 1 (Phases 6–7, with **Jul 30–31 reserved as float** for green-status-day recording and R1 outages). Total ≈ 22.5 dev-days over 21 calendar days at ~107 % utilization — honest statement: this only closes with agent-accelerated development and the trim order armed. Trim order (pre-committed, trigger = DoD ① not done by Jul 24 EOD): frontend polish → auditor UI (keep script-level auditor demo) → live timeout drill (keep code). **Phases 0–5 are never trimmed. GO-WITH-CUTS is the baseline video plan** (see 0b); a fully-live demo is the stretch case.

### Phase 0 — Day-0 spikes = GO/NO-GO gate (Jul 12–13, ~1.5 d)

**Objective:** burn down every remaining §7.6 unknown against live infra before any product code. Depends on: nothing.

**0a. Repo bootstrap (≈1 h)**
- [ ] Rename `README_NOXUS.md` → `README.md` (user-confirmed Q4); commit #1 includes `.gitignore` (`.env`, `node_modules/`, keys — G7)
- [ ] **Apply the §5 safety corrections from §1 above in the same commit** (address relabel + offsets), quoted in the S3 worklog entry
- [ ] Author `.env.example` (`DEPLOYER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, `ETH_SEPOLIA_RPC_URL`, `ARB_SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY`, `ARBISCAN_API_KEY`); `cp .env.example .env`
- [ ] `pnpm init`; install pinned: `@iexec-nox/handle@0.1.0-beta.13`, `@iexec-nox/nox-protocol-contracts@0.2.4`, `@iexec-nox/nox-confidential-contracts@0.2.2`, hardhat + toolbox, ethers v6, typescript. Compiler 0.8.27 (or highest Nox packages accept)
- [ ] Fund deployer + keeper (ETH faucets both chains); start banking Circle USDC now (20/2 h/address — 3–4 addresses)

**0b. `scripts/bench_nox_latency.ts` — the latency gate**
On BOTH chains (11155111, 421614), N ≥ 5 runs per metric, median + p90 + success rate, appended to the README worklog:
1. `encryptInput` wall time + **proof byte size** (feeds D-006)
2. `fromExternal` tx confirm time
3. one encrypted op (`add`) tx confirm time
4. client-decrypt RTT: `allow(h, user)` confirmed → SDK `decrypt(h)` returns
5. idle-handle reveal RTT: `allowPublicDecryption(h)` confirmed → SDK `publicDecrypt(h)` returns (plaintext, proof)
6. on-chain `Nox.publicDecrypt(h, proof)` staticcall sanity
7. **production-shaped reveal RTT (critical):** one tx chaining `fromExternal` + 3× `safeAdd`/`select` + `eq` + `allowPublicDecryption` on the same-tx result → time SDK `publicDecrypt`. This measures TEE-runner catch-up on the whole op DAG (what `checkEpoch` actually pays) and simultaneously **proves the same-tx symbolic-chaining assumption** the entire design rests on (ops return handle IDs synchronously; values materialize asynchronously — stated in §3.0, pinned from `Compute.sol` in Phase 1). Item 5 alone under-measures production.

**Decision tiers** (demo windows: settle inside 1:30–2:15, finalize inside 2:15–3:00; ETH Sepolia blocks are 12 s, so window 1 = closeEpoch confirm (~12–24 s) + reveal RTT + settleEpoch confirm (~12–24 s); the tiers partition all outcomes, using metric 7 medians):
- **GO-LIVE (stretch):** reveal-RTT median ≤ 15 s AND p90 ≤ 30 s AND success ≥ 4/5 on both chains → both reveals shown truly live. (Only this closes window 1 on 12 s blocks.)
- **GO-WITH-CUTS (baseline plan):** median ≤ 90 s AND p90 ≤ 150 s AND success ≥ 80 % → flow 100 % real; video bridges the two reveal waits with cuts + on-screen timestamps; `closeEpoch` fired at ~1:05 under deposit narration so the RTT runs beneath voice-over
- **NO-GO:** anything worse → escalate on Discord; demo restructures (epoch #1 fully pre-run + narrated, destination leg live); structural Nox unusability → pivot decision escalated to the human, not taken unilaterally
- Client-decrypt RTT median ≤ 20 s for the UI "decrypt my balance" moment; worse → UI pre-fetches during narration

**0c. Health probes — `scripts/probe_infra.ts`**
- [ ] Gateway HTTP 200 + JSON identity (green 2026-07-12) · both §5 subgraph endpoints (trivial GraphQL, assert non-error + recent block; log lag vs chain head → R6) · status-page scrape → worklog baseline (re-run before recording)

**0d. CCTP pinning (G2 closure)**
- [ ] Re-confirm both testnet addresses at developers.circle.com/cctp/evm-smart-contracts (verified this session — cite + log); `eth_call` on **BOTH chains' transmitters**: `maxMessageBodySize()` (expect 8192 — the ETH Sepolia send-side value binds hookData), `localDomain()` (0 / 3)
- [ ] `GET /v2/burn/USDC/fees/0/3` and `/3/0` → record live testnet bps (keeper fetches fresh at settle time)
- [ ] **Pin expiration/re-attestation semantics from vendored source + Iris docs:** who sets `expirationBlock`, window length at threshold 1000, does Iris support re-attestation of expired pre-finality messages (endpoint + preconditions)? Feeds the Phase-3 relay-retry loop and R4

**0e. hookData size + proof-binding test → D-006 decision**
With the real SDK, build dst-chain (421614) inputs; `hookData = abi.encode(uint256 epochId, Claim[])`, `Claim = (address recipient, bytes32 handle, bytes proof)`:
- [ ] N=3 and N=10 encoded sizes. Model: ≈ `96 + N × (160 + 32·⌈P/32⌉)` B (P = proof size; at P=137 → N=10 ≈ 3.3 KB vs 7,964 B — expect PASS ≥ 2× margin)
- [ ] Live wire test: `depositForBurnWithHook` from an EOA, N=3 blob, 1 USDC, ETH Sep → Iris attests → raw `receiveMessage` on Arb Sep → hookData recovered intact (bytes captured as L1 parser fixtures)
- [ ] **Proof-binding test (new unknown, this session):** NoxCompute checks `appInProof == msg.sender` + `ownerInProof == owner`. Account X creates a dst input bound to app = scratch contract; account Y triggers the scratch contract's self-call `fromExternal` (mimics depositor-creates / relayer-submits). Must pass for inline hookData. Pin what `owner` binds to in `Nox.sol` / SDK `encryptInput` params.
- **D-006 criteria:** inline (A) iff N=10 fits ≥ 2× AND binding passes AND wire test round-trips. Else pre-registration (B): recipients submit `(srcEpochId, recipient, dstHandle, dstProof)` to the Distributor via their own tx before source close (each user submits their own → sidesteps owner-binding too); Batcher `deposit` keeps `dstHandle` (32 B), drops `dstProof`; `hookData = abi.encode(epochId, claimCount, claimsHash)`; `relayReceive` matches count + keccak of ordered pairs. UX delta: one extra Arb tx + gas per depositor — worse, acceptable.

**0f. Discord questions — post verbatim Day 0:**
> **Q1 (deployment criterion):** "Hi team! Question on the deployment criterion. Our project is a confidential cross-chain USDC settlement over CCTP V2, so it is necessarily bi-chain: the user-facing leg (encrypted deposits, batching, epoch settlement, CCTP burn) is deployed on **Ethereum Sepolia**, and the distribution leg (CCTP mint + integrity check + confidential payout) on **Arbitrum Sepolia** — both calling the official unmodified CCTP V2 and Nox deployments. (a) Does the Ethereum Sepolia source leg satisfy the deployment requirement as stated in the brief? (b) If the requirement is instead Arbitrum Sepolia (as it was for Hack4Privacy and the Vibe Coding Challenge), does the bi-chain setup qualify via its Arbitrum Sepolia leg? A written yes/no on (a) or (b) would be great so we can log it. Thanks!"
> **Q2 (prior-project collision):** "Second question: was there any project at the Vibe Coding Challenge or Hack4Privacy doing confidential/batched CCTP transfers, or cross-chain USDC settlement with Nox? We want to be certain we don't collide with prior work, since reuse of a prior project is disqualifying. Our concept: batch ERC-7984-encrypted USDC deposits on the source chain, bridge one public aggregate via CCTP V2 Fast Transfer with hookData, and gate confidential distribution on the destination behind a TEE-verified integrity check. (Relatedly: our frontend shell adapts UI scaffolding from our own earlier hackathon repo, with all protocol logic new — please confirm that's acceptable.) Happy to share detail in DM."

**Commands:** `pnpm tsx scripts/bench_nox_latency.ts --chain {11155111,421614}` · `pnpm tsx scripts/probe_infra.ts`. **Exit:** tier declared with numbers in worklog; D-006 decided (or provisional pending only Discord); binding semantics pinned; both questions posted (answers tracked as R7).

### Phase 1 — Scaffold + ground truth from installed source (Jul 13–15, ~2 d)

**Objective:** everything G10-pinned from `node_modules`/vendored source; wrappers live. Depends on: Phase 0 GO.

- [ ] Vendor CCTP V2 interfaces + message constants → `contracts/interfaces/{ITokenMessengerV2,IMessageTransmitterV2}.sol`, `contracts/lib/CCTPMessageParser.sol` skeleton (offsets per §1; commit hash in headers)
- [ ] **Pin from installed Nox source (D-007/8/9 checklist):** wrapper unwrap/finalizeUnwrap/wrap exact shapes (fresh-handle finding) · **`confidentialTransfer` signature + return type** (currently assumed — G10) · external-input calldata type name (`externalEuint256`?) · `setOperator` API · **does `allow*` require `isAllowed(h, msg.sender)` on the granted handle?** (drives closeEpoch design — §3.1) · **does the wrapper/token grant recipients ACL on transfer/balance handles internally?** (drives the allow(t_i, …) rows) · `select` type genericity (ebool operands?) · `removeViewer` existence (§1 README promises revocable auditor access — absent ⇒ decision-change flag) · same-tx symbolic chaining from `Compute.sol`
- [ ] Deploy `cUSDCWrapper` ×2 (`scripts/00_deploy_wrappers.ts`): official wrapper, underlying = §1 USDC addresses, "Noxus Confidential USDC"/"cUSDC" (Q4 confirmed); explorer-verify both
- [ ] Live 1-USDC wrap → unwrap → finalizeUnwrap cycle on ETH Sepolia (`scripts/verify_wrapper_semantics.ts`) — proves the two-step reveal machinery before any Noxus code
- [ ] L2 fork spike: garbage-proof `fromExternal` against LIVE NoxCompute (published source ≠ deployed proxy impl — UUPS); `allowThis`-on-wrapper-owned-handle behavior; `isAllowed` staticcalls
- [ ] Local harness: hardhat chainId 11155111/421614 + `hardhat_setCode` `NoxComputeStub` at pinned addresses

**Commands:** `pnpm hardhat run scripts/00_deploy_wrappers.ts --network {ethSepolia,arbSepolia}` · `pnpm hardhat verify …` · `pnpm test`. **Exit:** D-007/8/9 logged in README decision log; wrappers live + verified; live cycle succeeded; stub harness green.

### Phase 2 — NoxusBatcher (Jul 15–18, ~3 d) — W1 exit

**Objective:** deposits + encSum correct; epoch settles on ETH Sepolia (burn behind a flag). Depends on: Phase 1.

- [ ] `contracts/NoxusBatcher.sol` per §3.1 (constructor init, deposit, withdrawDeposit, closeEpoch, settleEpoch, relayRefund skeleton, auditor passthroughs, view getters)
- [ ] L1 suite (`test/batcher.t.ts`): state machine, minDepositors reverts (close AND settle), ACL ordering (allowThis-after-mutation), encrypted-sum accumulation shape, withdrawDeposit accounting (sum sub + refund + count decrement), deposit cap, hookData encode
- [ ] `scripts/01_deploy_batcher.ts` · `scripts/10_demo_deposits.ts` (setOperator → dual encryptInput → deposit ×3) · `scripts/11_close_settle.ts` (close → concurrent SDK `publicDecrypt(encSum)` + `publicDecrypt(unwrapRequestId)` → settle)
- [ ] Testnet micro-epoch, burn flagged off: revealed A == known Σ, unwrap finalized, USDC balance delta == A

**Commands:** `pnpm hardhat run scripts/01_deploy_batcher.ts --network ethSepolia` · `pnpm tsx scripts/10_demo_deposits.ts` · `pnpm tsx scripts/11_close_settle.ts` · `pnpm test`. **Exit:** live epoch settles with correct A; suite green; Batcher explorer-verified. (DoD ① source half.)

### Phase 3 — CCTP leg + relayReceive (Jul 19–21, ~3 d)

**Objective:** first cross-chain mint with intact hookData. Depends on: Phase 2.

- [ ] Real `depositForBurnWithHook` enabled (maxFee from live Iris fees API, on-chain bound ≤ A/100)
- [ ] `NoxusDistributor.sol` (relayReceive + storage) + `CCTPMessageParser` complete; parser unit-tested against **real bytes captured in Phase 0e** (recorded live data, not mocks) incl. N=max and malformed-input fuzz (clean reverts leave the nonce unconsumed + message retryable)
- [ ] `scripts/02_deploy_distributor.ts` · `scripts/03_wire.ts` (peers + staticcall sanity) · `scripts/12_relay_mint.ts` — **relay loop: poll Iris → relay immediately on `complete`; detect expiry (per 0d pin) → re-attest → retry** (expirationBlock@196 makes prompt relay a correctness matter)
- [ ] destinationCaller = Distributor verified: direct `receiveMessage` from EOA reverts; `relayReceive` from any EOA succeeds
- [ ] Fund fee-subsidy buffers (~1 USDC plain USDC each side, §3.3)

**Commands:** `pnpm hardhat run scripts/02_deploy_distributor.ts --network arbSepolia` · `pnpm tsx scripts/12_relay_mint.ts`. **Exit:** live burn → attestation → relayReceive mints + stores blob; A + feeExecuted parsed correctly; Distributor explorer-verified.

### Phase 4 — Ingest + integrity check + happy path (Jul 21–24, ~3 d) — DoD ①

**Objective:** full honest E2E, zero mocks. Depends on: Phase 3.

- [ ] `ingestClaim`/`ingestAll`/`doIngest` (per-claim try/catch inside a batched loop — window-2 tx count drops), `checkEpoch` (okCount fold, §3.2), `finalizeEpoch` (wrap A + confidential distribution), `scripts/13_finalize.ts`
- [ ] L1 suite: ingest isolation (one bad claim ⇒ Invalid, epoch proceeds), okCount/checkNum fold on stub, distribution accounting, event shapes
- [ ] Honest E2E ×2 consecutively: 3 deposits → close → settle → bridge → relay → ingestAll → check reveal → finalize → recipients hold confidential cUSDC; one recipient client-decrypts
- [ ] First `pnpm audit:privacy` run (count == 3, event allowlist)

**Commands:** `pnpm tsx scripts/13_finalize.ts` · `pnpm test` · `pnpm audit:privacy`. **Exit:** DoD ① twice; `check == 1` KMS-proof-verified on-chain; zero mocks.

### Phase 5 — Fallback + refund leg (Jul 24–26, ~3 d) — DoD ②

**Objective:** adversarial epoch handled end-to-end on live testnets. Depends on: Phase 4.

- [ ] Distributor: `declareFallback` / `forceFallback` (widened guard, §3.2) / `requestClaimReveal` (opt-in, SITE 3) / `resolveClaim` / `initiateRefund`; Batcher: `relayRefund`
- [ ] Adversarial E2E on live testnets — **zero mocks by construction**: depositor #3 deposits enc(10) but ships a real-SDK dst input enc(999) → real `check == 0` → fallback → refund leg bridges A back → all depositors confidentially re-credited on ETH Sepolia; honest depositors #1/#2 optionally self-exculpate via `requestClaimReveal`
- [ ] Timeout drill: `CheckPending` epoch past `fallbackTimeout` (1 h testnet) → `forceFallback` from third-party EOA
- [ ] Zero-deposit griefing test: zero-balance depositor + nonzero dst claim → fallback → verify honest users' amounts were never revealed and refund makes everyone whole
- [ ] `audit:privacy` in CI

**Commands:** `pnpm tsx scripts/14_fallback_demo.ts` · `pnpm audit:privacy`. **Exit:** DoD ② live; grep == 3; refund credits verified by depositor client-decrypt.

### Phase 6 — Frontend (UI shell port) + auditor mode (Jul 26–29, ~4 d) — DoD ③

**Objective:** four views + keeper control panel, adapted from `an earlier hackathon UI` (user decisions Q1/Q2). Depends on: Phases 4–5 (frontend strictly after first E2E — §12).

Recon (2026-07-12): Vite 7 + React 19 JS SPA in `frontend/`; plain CSS; wagmi v3 + viem v2 (custom ConnectButton, injected connector); react-query; react-router; routes `/` (BridgeWidget), `/resources`, `/team` (ProfileCards (Aiden)); WebGL backgrounds (ogl/gsap); chain layer = classic `iexec` SDK, Arb Sepolia only; addresses in `src/config/contracts.js`; optional `FALLBACK_API` backend. **No LICENSE file.**

- [ ] Port shell: copy `frontend/`, rebrand Noxus; **TeamPage keeps only the Aiden card**; fix doubled `css/css`/`fonts/fonts` paths; stay JS
- [ ] Rip out classic-iExec layer (`iexec` SDK, orderbook/TEE-task code, `FALLBACK_API` path) → `@iexec-nox/handle` (`createViemHandleClient`) + wagmi calls; dual-chain config (ETH Sep + Arb Sep, switch prompts)
- [ ] Views: **Deposit** (BridgeWidget refit: balance pre-check (client-decrypt own cUSDC — blocks the innocent zero-transfer case) → `setOperator` → dual `encryptInput` → `deposit`) · **Epoch dashboard** (state, count, history; direct RPC primary, subgraph for history per R6) · **Decrypt-my-balance** · **Auditor** (grant `addViewer` → auditor decrypts one amount → `removeViewer`, on screen)
- [ ] **Keeper control panel (Q2: everything visible with proof):** buttons close → settle → relay → finalize (+ fallback controls), each showing live status: tx hash → explorer link, Iris state, KMS-proof fetched/verified indicators, revealed A, check result. CLI scripts remain the rehearsed instant fallback (R11)
- [ ] Compliance hygiene: record the base UI authors' written consent for shell reuse (no LICENSE — all-rights-reserved by default; user appears to be co-author — confirm) + credit in README ("frontend shell adapted from our earlier base UI; all Noxus logic new"); Discord Q2 already asks for confirmation
- [ ] Manual walkthrough on a live epoch, auditor flow from the UI

**Commands:** `pnpm dev` / `pnpm build` in `frontend/`. **Exit:** four views + keeper panel drive a live epoch start-to-finish from the UI; DoD ③.

### Phase 7 — Polish + ship (Jul 29–Aug 1, ~3 d incl. Jul 30–31 float) — DoD ④⑤

**Objective:** amendments, feedback, rehearsals, recording, submission. Depends on: Phase 6.

- [ ] README prose amendments per §1 list (quoted, flagged; §5 safety items already landed Day 0); decision-log rows D-007…D-011 appended (drafted in §7 below); D-004 row cross-annotated ("'self-exposing' superseded by D-010: exposure by attribution")
- [ ] `feedback.md` finalized from worklog candidates (S0–S3 already hold: docs  banner · starter 404 vs brief link · Hello-World-vs-brief chain mismatch · plugin template · stale "upcoming release" note · handle-layout docs mismatch · docs domain migration · Networks page data client-side-only · plus new)
- [ ] All contracts explorer-verified; `.env` hygiene audit; pre-demo check script: keeper gas both chains + **fee-buffer USDC levels both contracts** (also a pre-flight in keeper finalize/refund scripts — "anyone can top up" is the recovery)
- [ ] 2 dress rehearsals (one pulled earlier into Phase 6 exit if schedule allows); record on green-status day (float Jul 30–31); X draft @iEx_ec; submit per Discord-confirmed venue

**Commands:** `pnpm audit:privacy` · `pnpm tsx scripts/check_demo_ready.ts`. **Exit:** §10 checklist fully ticked; video ≤ 4 min; submitted.

---

## 3. Contract design (signatures + state machines — no implementation)

### 3.0 Design rules applied throughout
- Two-tx reveal everywhere (G6); **wall-clock RTTs, not reveal count, is the metric** — grants issued in one tx are proof-fetched concurrently
- **Stated assumption (pinned Phase 1, benched 0b-item-7):** Nox ops execute symbolically on-chain — handle IDs return synchronously; the TEE runner materializes values asynchronously — so one tx may chain `fromExternal → safeAdd → select → eq → allowPublicDecryption` on same-tx handles. `deposit` and `checkEpoch` depend on this.
- `allowThis` after every stored handle mutation (G4); user-facing handles get `allow(h, user)`. **Handles held only as pass-through data (stored + handed back to their owning contract) get NO ACL calls** — e.g. `unwrapRequestId`: the wrapper owns it and granted its own reveal; an `allowThis` on it could revert if grants require existing allowance (Phase-1 pin) and is unnecessary
- No `require`/`if` on encrypted values — `select` only (G5); `safeAdd/safeSub` + select for user-influenced sums
- **Exactly 3 `allowPublicDecryption` sites in authored code** (G3): SITE 1 `closeEpoch` (epoch sum) · SITE 2 `checkEpoch` (integrity result) · SITE 3 `requestClaimReveal` (opt-in fallback attribution, labeled). Wrapper-internal reveal = official vendored code, outside grep scope, reveals only the already-public aggregate — stated so the audit is reproducible; §7.5 amendment codifies it
- The `// PRIVACY FALLBACK — plaintext by design` label sits on **all fallback plaintext artifacts**: SITE 3, `resolveClaim`, `Claim.revealedAmount` field, `FallbackClaimRevealed` event definition; `audit:privacy` asserts label proximity on each
- Access model: **everything permissionless** — functions guarded by state + on-chain KMS-proof verification + Circle attestation, never caller identity. "Keeper" is whoever bothers (demo: our scripts/UI). Griefing surfaces closed individually: `maxFee ≤ A/100` on-chain both legs; `minDepositors` gated at `closeEpoch` + re-asserted at `settleEpoch` (§7.4); `depositorCount < maxClaims`. Exceptions (ownership, not privilege): `grantAuditor`/`revokeAuditor` (handle's privacy owner), `withdrawDeposit` (own deposit), `requestClaimReveal` (own claim)
- **k-floor honesty (documented in README amendment):** `minDepositors` is a heuristic floor valid against honest-but-curious observers; adversarial co-depositors (incl. zero-value sybils) can thin the real anonymity set — inherent to any open batcher, mitigated only by organic volume
- Complexity named and dropped: multi-epoch concurrent Batcher (sequential suffices; Distributor is per-epoch-keyed — exactly what lets demo epoch #1 pre-run, #2 live) · cheater bisection (D-004) · slashing bonds (D-004) · admin sweep · pausability/admin roles · Circle `sendMessage` plaintext side-channel · relayReceive store-raw/parse-split (parse is over a self-authored, fixture-tested format; a deterministic parse revert leaves the nonce unconsumed and message re-attestable — split adds a tx + state for no working escape, residual logged in R4)

### 3.1 NoxusBatcher.sol (ETH Sepolia)

**Epoch state machine:** `Open → Closed → Settled (→ Refunded)`. One active epoch; `settleEpoch` opens e+1. (If Phase-1 contradicts the fresh-handle wrapper finding, insert `Settling` for the two-sequential-RTT variant; D-007 records which shipped.)

**Storage:** `uint256 currentEpoch`; `mapping(uint256 => Epoch)`:
`Epoch { State state; euint256 encSum; euint256 unwrapRequestId; uint32 depositorCount; uint256 aggregate; bool refunded; Deposit[] deposits; DstClaim[] dstClaims; }`
`Deposit { address depositor; euint256 transferred; bool withdrawn; }` (kept for auditor + refund)
`DstClaim { address recipient; bytes32 dstHandle; bytes dstProof; }` — **opaque bytes here; never touch Nox on this chain** (§7.1)
Immutables: `srcWrapper`, `usdc`, `tokenMessengerV2`, `messageTransmitterV2`, `remoteDistributor (bytes32)`, `dstDomain = 3`, `minDepositors = 3`, `maxClaims`.
**View getters (keeper/SDK needs — auto-getters omit array/handle members):** `epochHandles(e) → (encSum, unwrapRequestId)` · `depositAt(e,i)` · `claimAt(e,i)` · `epochInfo(e)`.

| Function | Guards | Nox/ACL calls | Site |
|---|---|---|---|
| `constructor(…)` | — | open epoch 1: `encSum = toEuint256(0)`; `allowThis(encSum)` (§6: euint256 fields are NOT valid zero by default) | — |
| `deposit(address dstRecipient, externalEuint256 srcHandle, bytes srcProof, bytes32 dstHandle, bytes dstProof)` | Open; `depositorCount < maxClaims` | `amt = fromExternal(srcHandle, srcProof)` → `allowTransient(amt, srcWrapper)` → `transferred = srcWrapper.confidentialTransferFrom(msg.sender, this, amt)` (**D-009: accumulate the RETURNED handle** — amount-or-zero ⇒ solvency by construction; needs prior user `setOperator`) → `(ok, s) = safeAdd(encSum, transferred)`; `encSum = select(ok, s, encSum)` (overflow branch physically dead at USDC supply; kept for G5 form) → `allowThis(encSum)`; `allowThis(transferred)`; `allow(transferred, msg.sender)` (lets depositor client-detect a zero-short transfer) | — |
| `withdrawDeposit(uint256 e, uint256 i)` | Open; `msg.sender == deposits[i].depositor`; `!withdrawn` | **heals the innocent zero/short-transfer case + change-of-mind:** `(ok, s) = safeSub(encSum, transferred_i)`; `encSum = select(ok, s, encSum)`; `allowThis(encSum)`; `allowTransient(transferred_i, srcWrapper)`; `srcWrapper.confidentialTransfer(msg.sender, transferred_i)`; mark withdrawn; remove dstClaim; `depositorCount--` | — |
| `closeEpoch()` | Open→Closed; `depositorCount ≥ minDepositors` | **`allowPublicDecryption(encSum)` [SITE 1]**; `allowTransient(encSum, srcWrapper)`; `unwrapRequestId = srcWrapper.unwrap(this, this, encSum)` — **stored RAW, no ACL calls on it** (pass-through; wrapper granted its own reveal) | 1 |
| `settleEpoch(bytes proofA, bytes proofT, uint256 maxFee)` | Closed→Settled; re-assert minDepositors; `maxFee ≤ A/100` | `A = Nox.publicDecrypt(encSum, proofA)` (verification, not a grant); `bal0 = usdc.balanceOf(this)`; `srcWrapper.finalizeUnwrap(unwrapRequestId, proofT)`; **`require(usdc.balanceOf(this) − bal0 == A)`** (loud divergence check — wrapper released exactly A; SITE 1 is informationally redundant with the wrapper's reveal but required by §7.5 and keeps our on-chain A independent of wrapper internals, noted in D-007); approve; `depositForBurnWithHook(A, 3, remoteDistributor, usdc, remoteDistributor, maxFee, 1000, abi.encode(epochId, dstClaims))`; open e+1: `encSum = toEuint256(0)`; `allowThis(encSum)` | — |
| `relayRefund(bytes message, bytes attestation)` | epoch Settled ∧ !refunded | validate (`receiveMessage` success; srcDomain==3; body `messageSender == remoteDistributor`; `mintRecipient == bytes32(this)`; hook epochId matches; defensive `amount == aggregate`); `usdc.approve(srcWrapper, A)`; `srcWrapper.wrap(this, A)`; per non-withdrawn deposit: `allowTransient(transferred_i, srcWrapper)`; `t_i = srcWrapper.confidentialTransfer(depositor_i, transferred_i)`; **`allow(t_i, depositor_i)`** (symmetric with finalizeEpoch; Phase-1 pin whether the token self-grants — if so, both rows drop the explicit grant with reason noted) (Σ transferred = A exact — no dust) | — |
| `grantAuditor(e, i, auditor)` / `revokeAuditor(…)` | `msg.sender == deposits[i].depositor` | `addViewer(transferred_i, auditor)` / `removeViewer(…)` (existence pinned Phase 1) | — |

Keeper settle step fetches `publicDecrypt(encSum)` + `publicDecrypt(unwrapRequestId)` **concurrently** → one wall-clock KMS RTT for source settlement.

**Events:** `Deposited(epochId, depositor, dstRecipient, index)` (linkage public by calldata — confidentiality-not-anonymity) · `DepositWithdrawn(epochId, index)` · `EpochClosed(epochId, depositorCount)` · `EpochSettled(epochId, aggregate)` (public via burn) · `EpochRefunded(epochId)`. No per-user amounts anywhere.

### 3.2 NoxusDistributor.sol (Arb Sepolia)

**Per-epoch state machine:** `∅ → Received → (ingesting) → ClaimsIngested → CheckPending → Distributed | FallbackAttribution → RefundInitiated` (terminal-on-success; see expiration note). Fallback entries: failed check · `declareFallback` (any claim Invalid — plaintext fact) · `forceFallback` (timeout, widened guard).

**Storage:** `mapping(uint256 => E)`:
`E { State state; uint256 aggregate; uint256 feeExecuted; uint64 receivedAt; bytes hookBlob; Claim[] claims; uint32 ingestedCount; uint32 invalidCount; euint256 checkNum; uint64 checkRequestedAt; }`
`Claim { address recipient; euint256 ingested; ClaimStatus status; uint256 revealedAmount; /* PRIVACY FALLBACK — plaintext by design */ }`, `ClaimStatus { Pending, Ingested, Invalid, Revealed }`
Immutables: `dstWrapper`, `usdc`, `messageTransmitterV2`, `tokenMessengerV2`, `remoteBatcher (bytes32)`, `srcDomain = 0`, `fallbackTimeout` (1 h testnet).
**View getters:** `checkHandle(e)` · `claimAt(e,i)` · `epochInfo(e)`.

| Function | Guards | Nox/ACL calls | Site |
|---|---|---|---|
| `relayReceive(bytes message, bytes attestation)` | epoch unseen | minimal: `require(messageTransmitterV2.receiveMessage(message, attestation))` → validate versions, srcDomain==0, `messageSender == remoteBatcher`, `mintRecipient == bytes32(this)` → extract `A@[148+68]`, `feeExecuted@[148+164]`, `hookBlob@[148+228:]`; decode epochId; store; `receivedAt = now`. No Nox calls. (Revert rolls back the mint atomically — nonce unconsumed, message re-relayable/re-attestable.) | — |
| `ingestClaim(e, i)` / `ingestAll(e)` + `doIngest(bytes32 h, bytes proof) returns (euint256)` (self-call only) | Received/ingesting; claim Pending | decode claim in memory; `try this.doIngest(...)` → success: `allowThis(h)`, `allow(h, recipient)`, Ingested; catch: Invalid. Sync-revert verified ⇒ **one griefer invalidates one claim, never the epoch**. Self-call keeps NoxCompute's `msg.sender == Distributor` for `appInProof`. `ingestAll` = the same try/catch per claim in one loop tx (window-2 tx count ↓) | — |
| `checkEpoch(e)` | ClaimsIngested; `invalidCount == 0` | `encTotal = toEuint256(0)`; `okCount = toEuint256(0)`; per claim: `(ok_i, encTotal) = safeAdd(encTotal, ingested_i)`; `okCount = add(okCount, select(ok_i, toEuint256(1), toEuint256(0)))` (**collusion-overflow defense**: {2^256−x, x+A} wraps to exactly A under plain add). `checkNum = select(eq(okCount, toEuint256(N)), select(eq(encTotal, toEuint256(A)), toEuint256(1), toEuint256(0)), toEuint256(0))` — euint256-only nested select, every op in the verified §6 list (no `and(ebool)`; simplify in Phase 1 if `select` takes ebool operands); `allowThis(checkNum)`; **`allowPublicDecryption(checkNum)` [SITE 2]**; `checkRequestedAt = now` | 2 |
| `finalizeEpoch(e, bytes proof)` | CheckPending | `v = Nox.publicDecrypt(checkNum, proof)`; if `v == 1`: `require(usdc.balanceOf(this) ≥ A)` (buffer); approve; `dstWrapper.wrap(this, A)` (**wrap deferred to here deliberately** — never lock funds confidentially before the outcome; removes an unwrap RTT from fallback vs README §1 diagram); per claim: `allowTransient(ingested_i, dstWrapper)`; `t_i = dstWrapper.confidentialTransfer(recipient_i, ingested_i)`; `allow(t_i, recipient_i)` (Σ = A ⇒ no shorting) → Distributed. Else `_enterFallback()` | — |
| `declareFallback(e)` | ClaimsIngested ∧ `invalidCount > 0` | `_enterFallback()` — skips the check RTT | — |
| `forceFallback(e)` | **state ∈ {Received, ingesting, ClaimsIngested, CheckPending}** ∧ `now > max(receivedAt, checkRequestedAt) + fallbackTimeout` | `_enterFallback()` — hatch for stuck ingestion AND missing KMS proofs; refund needs zero Nox availability | — |
| `_enterFallback()` (internal) | — | **state flip only — reveals are NOT automatic** (see D-010: preserves honest privacy; removes the griefer's deanonymization payoff) → FallbackAttribution | — |
| `requestClaimReveal(e, i)` | Fallback states; `msg.sender == claims[i].recipient`; Ingested | **`allowPublicDecryption(ingested_i)` [SITE 3]** `// PRIVACY FALLBACK — plaintext by design` — opt-in self-exculpation; the cheater's refusal to reveal is itself the attribution signal | 3 |
| `resolveClaim(e, i, bytes proof)` `// PRIVACY FALLBACK — plaintext by design` | reveal requested | `v = Nox.publicDecrypt(ingested_i, proof)`; `revealedAmount = v`; Revealed. Informational only — gates nothing | — |
| `initiateRefund(e, uint256 maxFee)` | FallbackAttribution; `maxFee ≤ A/100` | approve; `depositForBurnWithHook(A, 0, remoteBatcher, usdc, remoteBatcher, maxFee, 1000, abi.encode(epochId))` → RefundInitiated — **terminal-on-success**: if the refund message expires unattested, the keeper re-attests + re-relays per the 0d-pinned procedure (inherited Circle/Iris-liveness trust, logged in R4; a permanent Circle pause strands A — accepted testnet risk, one line in README) | — |
| `grantAuditor(e, i, auditor)` / `revokeAuditor(…)` | `msg.sender == claims[i].recipient` | `addViewer(ingested_i, auditor)` / `removeViewer` | — |

**Events:** `EpochReceived(epochId, aggregate)` · `ClaimIngested(epochId, index)` / `ClaimInvalid(epochId, index)` · `CheckRequested(epochId)` · `EpochDistributed(epochId)` · `EpochFallback(epochId)` · `ClaimRevealRequested(epochId, index)` · `FallbackClaimRevealed(epochId, index, recipient, amount)` `// PRIVACY FALLBACK — plaintext by design` · `RefundInitiated(epochId, aggregate)`. This list IS the `audit:privacy` allowlist.

### 3.3 Fee accounting (gap in README flow, closed)
Fast Transfer mints `A − feeExecuted`; check + distribution are denominated in A. Both contracts hold a **fee-subsidy buffer** (~1 USDC plain testnet USDC at deploy — explicit operational subsidy, not mock data): Distributor needs `balance ≥ A` at finalize AND at initiateRefund; Batcher at relayRefund (`wrap(A)` after receiving A − feeRefund). **Every fallback epoch permanently drains ~2 fees from the buffers; if the Distributor buffer < feeIn, BOTH exits freeze until top-up** — buffer levels are in the pre-demo check script + keeper pre-flight; anyone can top up (recovery). Pro-rata fee deduction from recipients needs plaintext per-claim math — impossible confidentially; dropped.

### 3.4 Wrapper deployment parameters
One official `ERC20ToERC7984Wrapper` instance per chain (deploying instances is the intended use per README §4 — G1 bars touching CCTP/NoxCompute, not this): ETH Sep underlying `0x1c7D…7238`, Arb Sep `0x75fa…AA4d`; "Noxus Confidential USDC" / "cUSDC" (Q4). Exact constructor pinned from installed 0.2.2 source in Phase 1 (G10).

### 3.5 Decisions (flagged per §12; D-001…D-006 uncontradicted; D-010/D-011 amend §5/§3 prose)
- **D-007:** co-initiated dual-proof settle — one wall-clock KMS RTT (`closeEpoch` grants SITE 1 + starts wrapper unwrap; `settleEpoch` verifies both proofs + requires balance-delta == A). Basis: wrapper source verified 2026-07-12 (fresh-handle internal reveal). Alternatives: two sequential RTTs (fallback variant, +`Settling` state); plaintext-unwrap W3 (contradicted by source).
- **D-008:** `fromExternal` reverts synchronously (verified) → per-claim try/catch ingestion (`ingestAll` batches); `forceFallback` widened-guard timeout retained for KMS outage + stuck ingestion. Alternatives: whole-loop ingest (one griefer bricks epoch — rejected); async-poison design (contradicted by source).
- **D-009:** `encSum` accumulates the RETURNED `confidentialTransferFrom` handle (amount-or-zero) — solvency by construction; `withdrawDeposit` (safeSub + refund, Open only) heals the innocent zero-short case. Alternative: accumulate user handle (insolvent bridging — rejected).
- **D-010 (decision-change request — amends §3 prose, §1 mermaid fallback lane, §2 fallback-privacy line; D-004's epoch-granularity decision stands, its "self-exposing" rationale term becomes "exposed by attribution"):** fallback = **opt-in attribution reveal on destination + confidential refund-to-source via reverse CCTP leg**, replacing dst-side reveal-to-claim payouts. Rationale: any destination-only payout rule monotone in one's own claim is exploitable — the cheater's `encInput_dst` IS the inflated claim (pro-rata: a dust depositor claiming 2^255 captures ≈ all of A; FCFS: racy). Refund-to-source pays every depositor exactly their attested source amount confidentially — "cheater cannot claim more than attested" becomes literally true — and with reveals opt-in (`requestClaimReveal`, self-exculpation), honest amounts stay private in fallback unless their holders choose otherwise; the cheater's silence is the signal. Costs stated: reverse CCTP leg (~2–3 dev-days, parser shared), two fee buffers, exposure-by-attribution not automatic fingering. Griefing residual: forcing fallback costs the attacker gas only and delivers no deanonymization payoff — a refund-round-trip nuisance.
  **Emergency hedge (shelf design, if the reverse leg proves unusable in Phase 5):** dst-side claim window — `_enterFallback` opens a `claimWindow` (72 h param); per-claim states Revealed → Claimed; `claimFallback(e, i, proof)` after reveal pays `pay_i = min(revealed_i, revealed_i × A / Σrevealed-so-far-capped)` — concretely: payouts open only after window close, each paid `min(revealed_i, revealed_i × A / Σrevealed)`; unrevealed claims forfeit; residue (forfeits + rounding dust) stays in the contract, no sweep. Shipped ONLY with a documented honest-user-dilution warning. Strictly worse; exists so a late-W2 pivot needs no design session.
- **D-011 (amends README §5 destinationCaller note):** `destinationCaller = bytes32(Distributor)` (and `bytes32(Batcher)` on the refund leg) instead of `bytes32(0)`. With bytes32(0), anyone could call `receiveMessage` directly: mint lands but no epoch state initializes, and `relayReceive` then reverts forever on the consumed nonce — a real griefing vector. Pinning the caller makes mint + validation + hookData capture atomic inside `relayReceive`, which itself stays permissionless — relay remains anyone-can-do one level up (the verified `CCTPHookWrapper` pattern). Alternative: bytes32(0) + unattested-blob recovery function (unacceptable trust).

---

## 4. Test plan

**No-mock rule scope:** binds the final flow and demo. A local-only stub in `test/`, never deployed publicly, never in the demo, does not violate it — stated openly, limits below.

**L1 — Local unit tests (every commit).** `test/stubs/NoxComputeStub.sol`: plaintext-behind-bytes32 pseudo-handles; `fromExternal` reverts on a bad-proof marker (mirrors verified semantics); arithmetic/eq/select on plaintexts; ACL calls recorded for ordering assertions. Injection without product-code changes: hardhat chainId 11155111/421614 + `hardhat_setCode` at pinned NoxCompute addresses. Real vendored wrapper runs on the stub for plumbing coverage. CCTP: `MessageTransmitterStub` + **real byte fixtures from the Phase-0e wire test** (recorded live data). *Proves:* state machines, guards, minDepositors reverts, sum-accumulation shape, withdrawDeposit accounting, ACL ordering, per-claim isolation, okCount/checkNum fold, declareFallback, widened forceFallback, refund accounting, hookData encode/decode, offset parsing + malformed-input fuzz, event shapes. *Cannot prove:* real ACL semantics, chain-scoping, proof formats, KMS latency, TEE op semantics, wrapper fidelity, attestations — all live at L3.

**L2 — One-shot fork spikes (Phase 1).** Fork ETH Sepolia: garbage-proof `fromExternal` vs LIVE NoxCompute (UUPS impl ≠ published source — cheap to confirm); `allowThis`-on-wrapper-owned-handle behavior (the closeEpoch brick question); `isAllowed` staticcalls. Decryption/KMS can't fork — nothing else.

**L3 — Testnet integration (primary correctness layer).** Scripted, idempotent, tx hashes logged, state asserted between steps; amounts 1–3 USDC. Standing scenarios (all zero-mock), run at every phase exit from Phase 3 and ×2 before recording:
1. **Honest epoch** → `check == 1` → confidential distribution (DoD ①)
2. **Adversarial epoch** — real-SDK dishonest dst input enc(999) vs deposit enc(10) → real `check == 0` → opt-in reveals → refund lands (DoD ②) — a dishonest depositor is real data; the final adversarial demo needs no harness
3. **Zero-deposit griefing** — zero-balance depositor + nonzero claim → fallback with **no honest reveals** + full refund

**`pnpm audit:privacy` (CI + pre-deploy):**
1. `allowPublicDecryption` in authored `contracts/**` (vendored excluded) **== 3**, each within 2 lines of its `REVEAL SITE n` label
2. `PRIVACY FALLBACK` label present on: SITE 3, `resolveClaim`, `revealedAmount` field, `FallbackClaimRevealed` event
3. Event scan: no amount-typed param outside allowlist {`EpochSettled`, `EpochReceived`, `RefundInitiated` (aggregate), `FallbackClaimRevealed` (labeled)}
4. G5 heuristic: `require(`/`if (` on lines mentioning `ebool|euint` → manual review
5. No `.env`/keys staged (pre-commit)

---

## 5. Risk register

| # | Risk | Trigger signal | Plan B |
|---|---|---|---|
| R1 | Nox infra flakiness (KMS/runner/gateway) | status red; bench success < 80 %; proof timeouts | Retry (all functions re-callable); `forceFallback`+refund moves funds with ZERO Nox dependency; record on green day (float Jul 30–31); log incidents in feedback.md (G9) |
| R2 | Reveal RTT above threshold | bench metric-7 median > 15 s (live) / > 90 s (cuts) | GO-WITH-CUTS is already the baseline; > 90 s → pre-run epoch #1 + live destination leg only; structural failure → human pivot decision |
| R3 | hookData too big / proof-binding fails (D-006) | 0e: N=10 > ~4 KB or X-creates/Y-submits reverts | Option B pre-registration (interface delta in 0e); size math already safe (137 B ⇒ N=10 ≈ 3.3 KB); binding failure alone forces B |
| R4 | Message format/expiration surprises | 0e wire test fails; parser fixtures fail; message expires unattested (either leg) | We call `receiveMessage` ourselves + parse vendored offsets (no callback assumed); expiration/re-attestation procedure pinned 0d, relay loop retries + re-attests (Phase 3); parse reverts leave nonce unconsumed + message re-attestable (format self-authored, fixture-tested); Circle upgrade → re-vendor |
| R5 | Wrapper friction (settle breaks) | Phase-1 read contradicts fresh-handle finding; 1-USDC cycle fails; balance-delta ≠ A | Two-sequential-RTT variant (+`Settling`, §3.1); delta-check fails loudly with documented top-up recovery; KMS outage mid-unwrap = cUSDC burned pending finalize — accepted, documented (G1 bars hatches in official code) |
| R6 | Subgraph lag breaks auditor/dashboard UX | 0c probe lag ≫ block time; stale viewACL during demo | Frontend reads chain directly (events + staticcalls) as primary; subgraph history-only; auditor demo falls back to script |
| R7 | Discord answers negative/absent | no reply ~4 days; "must be Arb Sepolia" | A leg exists on each chain — either reading covered (predecessors wanted Arb; README brief says ETH); single-chain demand → direction swap is constructor params; absent → screenshot question + timestamps in README, proceed bi-chain |
| R8 | Keeper key/gas management | script failures; drained/nonce-stuck account | Two funded accounts Day 0; pre-demo balance+buffer check; idempotent resumable steps; any EOA substitutes (permissionless) |
| R9 | Epoch stuck: KMS proof never arrives / buffers empty | `Closed`/`CheckPending` > timeout; buffer < fee | Dst: widened `forceFallback` → refund (no Nox needed). Src `Closed`: wait+retry only (accepted, documented; small demo amounts). Buffer freeze: anyone tops up (keeper pre-flight warns) |
| R10 | Prior-art collision | Discord Q2 reveals similar prior project | §11 claim wording already narrow; differentiate in related-work; re-angle pitch (integrity check + refund leg are novel) |
| R11 | Frontend port liabilities (base UI) | license question; recycled-UI optics; UI keeper step fails on camera | No LICENSE upstream → record authors' written consent (user appears to be co-author — confirm) + README credit + provenance disclosure ("all Noxus logic new"); Discord Q2 asks explicitly; CLI fallback rehearsed for every keeper step |
| R12 | Gas-only fallback-forcing griefer | repeated `check == 0` epochs w/ zero-value deposits | By design post-critique: opt-in reveal removes deanonymization payoff; refund makes everyone whole; cost to us = fee-buffer drain (monitored) + nuisance; k-floor documented as heuristic; organic-volume mitigation only (bonds stay dropped per D-004) |

---

## 6. Deliverables mapping

| Phase exit | §10 compliance item | §12 DoD |
|---|---|---|
| 0 | organizer confirmations logged (Q1/Q2, dated) · no-reuse validated · §5 corrections landed | — (gate) |
| 1 | wrappers explorer-verified | — |
| 2 | — | ① source half |
| 3 | deployed on ETH Sepolia (source leg live) | — |
| 4 | E2E no mock data (honest) | **①** |
| 5 | — | **②** |
| 6 | functional frontend | **③** |
| 7 | repo complete · README amended · **feedback.md ()** · video ≤ 4 min · X @iEx_ec · team ≤ 5 | **④** (verified, no per-user amount findable) · **⑤** |

**feedback.md schedule:** created at commit #1 with the eight existing candidates (S0–S3); appended immediately on friction (G9); Phase 7 prose pass.

---

## 7. Worklog compliance

Entry to append to README §13 at S3 close-out (template order: Done / Verified / Open / Next / feedback.md candidates; decisions go to the Decision Log table):

```
#### Session 3 — 2026-07-12 — claude — Implementation plan + external verification + adversarial design review
**Done:** implementation plan (docs/PLAN.md): 8 phases W1–W3; Phase-0 GO/NO-GO gate w/ partitioned latency
tiers (GO-LIVE ≤15 s median / GO-WITH-CUTS ≤90 s = baseline / NO-GO); both contracts at signature+state-machine
level w/ per-function ACL map (3 reveal sites: closeEpoch / checkEpoch / requestClaimReveal); test pyramid
(local stub → fork spike → testnet-primary); 12-risk register; deliverables mapping. Design passed 3-critic
adversarial review; fixes folded in (opt-in fallback reveal, withdrawDeposit healing, balance-delta settle
check, widened forceFallback, expiration handling, production-shaped bench item). User decisions: frontend =
base UI shell port (Aiden card only); keeper via frontend w/ visible proof; amounts 3.10/2.45/4.45;
README renamed at commit #1.
**Verified (primary sources, 2026-07-12):** TokenMessengerV2 testnet 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
+ MessageTransmitterV2 testnet 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 — SAME both chains (developers.
circle.com/cctp/evm-smart-contracts) · §5's 0x81D4…4B64 is MAINNET transmitter — corrected in §5 this session ·
BurnMessageV2 feeExecuted@164 / expirationBlock@196 (§5 had them swapped — corrected), outer header 148 B ·
maxMessageBodySize 8192 → hookData ≈7964 B · Circle never executes hooks (official CCTPHookWrapper.sol =
wrap receiveMessage + parse; destinationCaller = exclusive receiveMessage caller) · no npm pkg for CCTP
contracts → vendor circlefin/evm-cctp-contracts · Iris v2 endpoints + /v2/burn/USDC/fees · faucet 20 USDC/2 h ·
ERC-7984 pkg pinned @iexec-nox/nox-confidential-contracts@0.2.2 (+protocol 0.2.4, handle beta.13) · wrapper
unwrap burns to FRESH handle + self-grants allowPublicDecryption; finalizeUnwrap(unwrapRequestId, proof) ·
confidentialTransferFrom returns transferred-or-zero euint256 · fromExternal REVERTS synchronously (137-B
proof; appInProof==msg.sender; ownerInProof==owner) · handle chainId bytes [1-4] (docs "[26-29]": no live
source) · Nox status all-green · no summer-event page found; both predecessor briefs required ARB Sepolia →
Discord Q1 covers both directions.
**Open:** Phase-0 live bench (incl. production-shaped chained-op RTT + proof-binding test) · Discord Q1/Q2
answers · remaining README prose amendments (Phase 7 list in plan §1) · D-007/8/9 node_modules re-confirmation.
**Next:** Phase 0 execution.
**feedback.md candidates:** docs Networks page data client-side-only (unscrapable) · handle-layout "[26-29]"
docs claim unsourced · nox-hardhat-plugin@0.1.0 published but template.
```

Decision Log rows to append (ID/Decision/Alternatives/Rationale/Date):
| ID | Decision | Alternatives | Rationale | Date |
|---|---|---|---|---|
| D-007 | Co-initiated dual-proof settle (1 wall-clock RTT); settle requires balance-delta == A | two sequential RTTs; plaintext unwrap | wrapper source: unwrap burns to fresh self-revealed handle; delta-check fails loudly on divergence | 07-12 |
| D-008 | Per-claim try/catch ingest (ingestAll batch); widened forceFallback timeout | whole-loop ingest; async-poison design | fromExternal verified sync-revert; one griefer must not brick a minted epoch | 07-12 |
| D-009 | encSum accumulates RETURNED transfer handle; withdrawDeposit heals zero-short | accumulate user handle | transferred-or-zero semantics verified; solvency by construction | 07-12 |
| D-010 | Fallback = opt-in dst attribution reveal + confidential refund-to-source (reverse CCTP leg). Amends §3 prose/§1 mermaid/§2 fallback line; D-004 epoch granularity stands ("self-exposing" → "exposed by attribution") | dst pro-rata (exploitable: inflated claim captures A); FCFS (racy); reveal-window hedge (shelf) | only design where cheater literally cannot claim more than attested AND honest amounts stay private in fallback | 07-12 |
| D-011 | destinationCaller = our contract on both legs (relay stays permissionless via relayReceive/relayRefund) | bytes32(0) per §5 note | direct receiveMessage would mint without epoch state and consume the nonce — strands the epoch | 07-12 |

All future sessions follow §12 protocol: ① read §7 + STATE + last 2 worklog entries, one-paragraph plan first ② small verified steps, compile+test each change, never end uncompilable ③ mandatory close-out: append-only worklog, STATE tick, decisions logged with alternatives. Plan saved as `docs/PLAN.md` at Phase 0 commit and referenced from the worklog.

---

## 8. Questions for the human

Asked interactively 2026-07-12 — answers recorded:
1. **Frontend stack** → **port an earlier hackathon UI exactly, adapted to Noxus; team page keeps only the Aiden card.** (Its stack — Vite+React+wagmi/viem — matches the original recommendation; port replaces its classic-iExec layer with the Nox handle SDK. Recon in Phase 6; liabilities in R11.)
2. **Keeper** → **everything visible and driven via the frontend, with on-screen proof per step.** Phase 6 keeper panel (tx links, Iris state, KMS-proof indicators, check result); CLI stays as rehearsed fallback.
3. **Demo amounts** → **3.10 / 2.45 / 4.45 → A = 10.00 USDC** per epoch (~60 USDC total incl. rehearsals — fine with faucet banking).
4. **Naming + rename** → **keep spec names; rename to `README.md` at commit #1.**
5. **Single active epoch in v1 (recommended, adopted — say the word to override):** sequential epochs on the Batcher; Distributor per-epoch-keyed (this is what lets epoch #1 pre-run and #2 run live). Concurrent epochs = future work.
6. **D-010 fallback redesign (flagged for your awareness — §3.5):** the README's destination-side reveal-to-claim was replaced with opt-in-reveal + refund-to-source after the destination-only design was shown exploitable (an inflated claim captures ~all of A under pro-rata). The README's own "cheater cannot claim more than attested" only holds under the refund design. A shelf hedge exists if the reverse leg disappoints. Object now if you want the original dst-side design regardless.

---

## 9. Future work (out of scope — listed once)

Redemptions/reverse settlement as a product feature (refund leg is failure-handling only) · multi-epoch concurrency · cheater bisection · slashing bonds · admin sweep of residue · mainnet hardening/audit · pro-rata fee deduction · gas golf.

---

## 10. Verification (how we know it all worked)

1. Phase gates met on live testnets, tx hashes in the worklog.
2. DoD ①: honest 3-depositor epoch ETH Sep → Arb Sep, `check == 1` KMS-proof-verified on-chain, recipients decrypt confidential balances — twice consecutively.
3. DoD ②: real-SDK corrupted-claim epoch → `check == 0` → opt-in attribution reveals → refund lands on ETH Sep, depositors re-credited confidentially (verified by client-decrypt); plus the zero-deposit griefing scenario with no honest reveals.
4. `pnpm audit:privacy` green (count == 3, labels present, event allowlist clean); manual explorer review: no per-user amount findable on-chain.
5. Demo dress rehearsal ×2 inside 4 minutes on a green-status day; all explorer links resolve to verified contracts; keeper panel drives the live epoch with visible proofs.
